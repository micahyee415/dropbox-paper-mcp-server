/**
 * Dropbox MCP Server
 *
 * Full Dropbox Files + Dropbox Paper access for @example.com accounts, deployed to Cloud Run.
 *
 * Architecture:
 *   1. Express HTTP server with Google OAuth validation on every /mcp request
 *   2. Per-request McpServer + StreamableHTTPServerTransport (stateless)
 *   3. Dropbox Business API with per-user impersonation:
 *      - TeamMemberCache maps authenticated user email → Dropbox team_member_id at startup
 *      - Each request uses Dropbox-API-Select-User set to the authenticated user's dbmid
 *      - Users see only their own files with their own sharing/visibility permissions
 *      - Non-Dropbox team members are rejected with 403
 *
 * Tools (25 total):
 *   Files:   list_folder, get_metadata, search_files, download_file, get_temporary_link,
 *            upload_file, create_folder, move_file, copy_file, delete_file,
 *            permanently_delete_file, list_revisions, restore_revision, export_file
 *   Paper:   list_paper_docs, create_paper_doc, update_paper_doc
 *   Sharing: create_shared_link, list_shared_links, revoke_shared_link,
 *            add_file_member, list_file_members, remove_file_member
 *   Account: get_account_info, get_space_usage
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DropboxClient, DropboxTokenManager } from "./dropbox-client.js";
import { TeamMemberCache } from "./team-cache.js";
import { registerFileTools } from "./tools/files.js";
import { registerPaperTools } from "./tools/paper.js";
import { registerSharingTools } from "./tools/sharing.js";
import { registerAccountTools } from "./tools/account.js";
import { verifyGoogleToken, extractBearerToken, AuthError } from "./auth.js";
import { logger } from "./logger.js";
import { RateLimiter } from "./rate-limiter.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN ?? "example.com";
const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
const ALLOWED_ORIGINS = ["https://claude.ai", "https://api.claude.ai"];

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// ─── Dropbox admin client (team-level, no user selected) ─────────────────────
// Used for: health check (/team/get_info), team member cache population.
// NOT used for file operations — those use per-request user-scoped clients.

const tokenManager = new DropboxTokenManager(
  requireEnv("DROPBOX_APP_KEY"),
  requireEnv("DROPBOX_APP_SECRET"),
  requireEnv("DROPBOX_REFRESH_TOKEN")
);
const dropboxAdminClient = new DropboxClient(tokenManager);

// ─── Team member cache ────────────────────────────────────────────────────────
// Maps @example.com email → Dropbox team_member_id (dbmid:...).
// Populated at startup, refreshed every hour.

const teamCache = new TeamMemberCache();

// ─── MCP server factory ───────────────────────────────────────────────────────

function createMcpServer(userClient: DropboxClient, requestId: string, userEmail: string): McpServer {
  const server = new McpServer({ name: "dropbox", version: "1.0.0" });
  registerFileTools(server, userClient, requestId, userEmail);
  registerPaperTools(server, userClient, requestId, userEmail);
  registerSharingTools(server, userClient, requestId, userEmail);
  registerAccountTools(server, userClient, requestId, userEmail);
  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const rateLimiter = new RateLimiter(60, 60_000);
const app = express();
app.use(express.json({ limit: "4mb" }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const startMs = Date.now();
  try {
    const { teamName } = await dropboxAdminClient.validateCredentials();
    const durationMs = Date.now() - startMs;
    logger.info("Health check passed", {
      event: "health_check",
      outcome: "success",
      dropboxTeam: teamName,
      cachedMembers: teamCache.size,
      durationMs,
    });
    res.status(200).json({
      status: "ok",
      version: "1.0.0",
      transport: "http",
      dropbox_team: teamName,
      cached_members: teamCache.size,
    });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    logger.error("Health check failed — Dropbox credentials invalid", {
      event: "health_check",
      outcome: "error",
      reason: String(err),
      durationMs,
    });
    res.status(503).json({
      status: "error",
      reason: "Dropbox credentials invalid or API unreachable.",
    });
  }
});

// ─── OAuth metadata (RFC 8414 + RFC 7591) ─────────────────────────────────────

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: SERVER_URL,
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    registration_endpoint: `${SERVER_URL}/register`,
    scopes_supported: ["openid", "email", "profile"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
  });
});

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: SERVER_URL,
    authorization_servers: ["https://accounts.google.com"],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
  });
});

app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json({
    resource: `${SERVER_URL}/mcp`,
    authorization_servers: ["https://accounts.google.com"],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
  });
});

// ─── Dynamic Client Registration (RFC 7591) ───────────────────────────────────

app.post("/register", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: "OAuth client credentials not configured on server." });
    return;
  }
  const redirectUris: string[] = (req.body?.redirect_uris ?? []).filter(
    (uri: unknown) => typeof uri === "string" && uri.startsWith("https://")
  );
  logger.info("Dynamic client registration", {
    event: "registration",
    origin: req.headers.origin ?? "unknown",
  });
  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
});

// ─── MCP endpoint ─────────────────────────────────────────────────────────────

app.all("/mcp", async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.status(204).end();
    return;
  }

  const startMs = Date.now();
  // Unique ID for correlating all log lines within a single MCP request
  const requestId = randomUUID();

  // 1. Extract and validate Google OAuth token
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    logger.warn("Missing auth token", { requestId, statusCode: 401, outcome: "auth_failure" });
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`
    );
    res.status(401).json({
      error: "Missing Authorization header. Use Bearer <Google OAuth token>.",
    });
    return;
  }

  let userEmail: string;
  try {
    const authResult = await verifyGoogleToken(token, ALLOWED_DOMAIN);
    userEmail = authResult.email;
    logger.info("User authenticated", { requestId, event: "login", userEmail });
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn("Auth failed", {
        requestId,
        event: "auth_failure",
        outcome: "auth_failure",
        statusCode: err.statusCode,
        reason: err.message,
      });
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error("Unexpected auth error", { requestId, event: "auth_failure", outcome: "error", reason: String(err) });
    res.status(500).json({ error: "Authentication failed." });
    return;
  }

  // 2. Resolve authenticated user to their Dropbox team_member_id
  const teamMemberId = teamCache.lookup(userEmail);
  if (!teamMemberId) {
    logger.warn("User not found in Dropbox team", { requestId, event: "auth_failure", outcome: "auth_failure", userEmail });
    res.status(403).json({
      error: `${userEmail} is not an active Dropbox team member. Contact IT to provision Dropbox access.`,
    });
    return;
  }

  // 3. Per-user rate limiting
  if (!rateLimiter.check(userEmail)) {
    const retryAfter = rateLimiter.retryAfter(userEmail);
    logger.warn("Rate limit exceeded", { requestId, event: "rate_limited", outcome: "rate_limited", userEmail, retryAfter });
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Rate limit exceeded. Try again in ${retryAfter}s.` });
    return;
  }

  // 4. CORS headers
  const origin = req.headers.origin;
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  // 5. Handle MCP request with a user-scoped Dropbox client
  const tool: string | undefined =
    req.body?.method === "tools/call" ? req.body?.params?.name : req.body?.method;

  const userClient = dropboxAdminClient.forUser(teamMemberId);
  const server = createMcpServer(userClient, requestId, userEmail);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  const durationMs = Date.now() - startMs;
  const statusCode = res.statusCode;
  const outcome = statusCode >= 500 ? "error" : "success";

  logger.info("Request completed", {
    requestId,
    event: "usage",
    userEmail,
    tool,
    durationMs,
    statusCode,
    outcome,
  });

  // Emit a slow-request warning if p99 SLO is breached (>5s)
  if (durationMs > 5000) {
    logger.warn("Slow request: exceeded 5s latency SLO", {
      requestId,
      userEmail,
      tool,
      durationMs,
      event: "slo_breach",
    });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

async function start() {
  // Populate team member cache before accepting traffic
  logger.info("Loading Dropbox team member cache...");
  await teamCache.init(dropboxAdminClient);
  logger.info("Team member cache ready", { members: teamCache.size });

  const httpServer = app.listen(PORT, () => {
    logger.info("Dropbox MCP server ready", { port: PORT, allowedDomain: ALLOWED_DOMAIN });
  });

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received — draining connections...");
    httpServer.close(() => {
      logger.info("HTTP server closed. Exiting.");
      process.exit(0);
    });
  });
}

start().catch((err) => {
  logger.error("Failed to start server", { reason: String(err) });
  process.exit(1);
});
