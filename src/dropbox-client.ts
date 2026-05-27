/**
 * Dropbox API v2 client.
 *
 * Handles two distinct API surfaces:
 *   - api.dropboxapi.com/2/   — metadata + control operations (JSON in, JSON out)
 *   - content.dropboxapi.com/2/ — file content operations (params in Dropbox-API-Arg header)
 *
 * Auth: OAuth 2.0 with offline access (refresh token).
 * Access tokens expire every 4 hours — this client auto-refreshes them transparently.
 *
 * Architecture:
 *   DropboxTokenManager  — singleton, owns the access token cache (shared across requests)
 *   DropboxClient        — created per-request via forUser(dbmid); shares the token manager
 *
 * Retry: exponential backoff on 429 (rate limit) and 5xx responses.
 */

import { logger } from "./logger.js";

const API_BASE     = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";
const TOKEN_URL    = "https://api.dropbox.com/oauth2/token";

// Refresh token 5 minutes before actual expiry to avoid mid-request failures
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DropboxFileMetadata {
  ".tag": "file";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  client_modified: string;
  server_modified: string;
  rev: string;
  size: number;
  is_downloadable: boolean;
  export_info?: { export_as?: string; export_options?: string[] };
}

export interface DropboxFolderMetadata {
  ".tag": "folder";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
}

export interface DropboxDeletedMetadata {
  ".tag": "deleted";
  name: string;
  path_lower: string;
  path_display: string;
}

export type DropboxMetadata = DropboxFileMetadata | DropboxFolderMetadata | DropboxDeletedMetadata;

export interface DropboxListFolderResult {
  entries: DropboxMetadata[];
  cursor: string;
  has_more: boolean;
}

export interface DropboxSearchResult {
  matches: Array<{
    match_type: { ".tag": string };
    metadata: { metadata: DropboxMetadata };
  }>;
  has_more: boolean;
  cursor?: string;
}

export interface DropboxSharedLink {
  url: string;
  name: string;
  path_lower?: string;
  link_permissions?: Record<string, unknown>;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
  size?: number;
  id?: string;
  expires?: string;
  link_metadata?: Record<string, unknown>;
}

export interface DropboxRevision {
  id: string;
  is_deleted: boolean;
  entries: DropboxFileMetadata[];
  is_latest?: boolean;
}

export interface DropboxSpaceUsage {
  used: number;
  allocation:
    | { ".tag": "individual"; allocated: number }
    | { ".tag": "team"; used: number; allocated: number; user_within_team_space_allocated: number; user_within_team_space_limit_type: Record<string, unknown> };
}

export interface DropboxAccount {
  account_id: string;
  name: { given_name: string; surname: string; display_name: string };
  email: string;
  email_verified: boolean;
  profile_photo_url?: string;
  disabled: boolean;
  is_teammate?: boolean;
  team_member_id?: string;
  team?: { id: string; name: string; sharing_policies?: Record<string, unknown> };
  account_type: { ".tag": string };
  root_info: { ".tag": string; root_namespace_id: string; home_namespace_id: string };
}

export interface DropboxTeamInfo {
  name: string;
  team_id: string;
  num_licensed_users: number;
  num_provisioned_users: number;
}

export interface DropboxFileMembersResult {
  users: Array<{
    access_type: { ".tag": string };
    user: { account_id: string; email?: string; display_name?: string };
    permissions: unknown[];
    is_inherited: boolean;
  }>;
  groups: unknown[];
  invitees: Array<{
    access_type: { ".tag": string };
    invitee: { ".tag": string; email?: string };
    permissions: unknown[];
    is_inherited: boolean;
  }>;
  cursor?: string;
}

// ─── DropboxTokenManager ──────────────────────────────────────────────────────
// Singleton — owns the access token and refresh logic.
// Shared across all per-request DropboxClient instances so tokens are only
// refreshed once per expiry window even under concurrent requests.

export class DropboxTokenManager {
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(
    private appKey: string,
    private appSecret: string,
    private refreshToken: string
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    logger.info("Refreshing Dropbox access token");

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.appKey,
        client_secret: this.appSecret,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to refresh Dropbox token (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS;

    logger.info("Dropbox access token refreshed", {
      expiresInMin: Math.round(data.expires_in / 60),
    });

    return this.accessToken;
  }
}

// ─── DropboxClient ────────────────────────────────────────────────────────────
// Lightweight per-request client. Shares a DropboxTokenManager for token
// caching. selectUser is the Dropbox team_member_id (dbmid:...) to impersonate —
// when set, all API calls include Dropbox-API-Select-User so the call executes
// under that team member's identity with their exact permissions.

export class DropboxClient {
  constructor(
    private tokenManager: DropboxTokenManager,
    private selectUser?: string
  ) {}

  /**
   * Returns a new client scoped to a specific team member.
   * Shares the same token manager — no extra token refreshes.
   */
  forUser(teamMemberId: string): DropboxClient {
    return new DropboxClient(this.tokenManager, teamMemberId);
  }

  // ── Core fetch helpers ────────────────────────────────────────────────────

  /**
   * POST to the metadata API (api.dropboxapi.com/2/).
   * Body is JSON; response is JSON.
   */
  async callApi<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.withRetry(async () => {
      const token = await this.tokenManager.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      if (this.selectUser) headers["Dropbox-API-Select-User"] = this.selectUser;

      const hasBody = Object.keys(body).length > 0;
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers,
        body: hasBody ? JSON.stringify(body) : "null",
      });

      await this.assertOk(res, endpoint);
      return res.json() as Promise<T>;
    });
  }

  /**
   * POST to the content API (content.dropboxapi.com/2/).
   * API args go in the Dropbox-API-Arg header; body is file content (text).
   */
  async uploadContent<T>(
    endpoint: string,
    args: Record<string, unknown>,
    content: string
  ): Promise<T> {
    return this.withRetry(async () => {
      const token = await this.tokenManager.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(args),
      };
      if (this.selectUser) headers["Dropbox-API-Select-User"] = this.selectUser;

      const res = await fetch(`${CONTENT_BASE}${endpoint}`, {
        method: "POST",
        headers,
        body: content,
      });

      await this.assertOk(res, endpoint);
      return res.json() as Promise<T>;
    });
  }

  /**
   * POST to the content API and return the response body as text.
   * The Dropbox-API-Result header contains metadata (parsed separately).
   */
  async downloadContent(
    endpoint: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; metadata: Record<string, unknown> }> {
    return this.withRetry(async () => {
      const token = await this.tokenManager.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify(args),
      };
      if (this.selectUser) headers["Dropbox-API-Select-User"] = this.selectUser;

      const res = await fetch(`${CONTENT_BASE}${endpoint}`, {
        method: "POST",
        headers,
      });

      await this.assertOk(res, endpoint);

      const content = await res.text();
      const resultHeader = res.headers.get("Dropbox-API-Result");
      const metadata: Record<string, unknown> = resultHeader
        ? (JSON.parse(resultHeader) as Record<string, unknown>)
        : {};

      return { content, metadata };
    });
  }

  // ── Retry logic ───────────────────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        lastError = err;
        const isRetryable =
          err instanceof DropboxApiError &&
          (err.statusCode === 429 || err.statusCode >= 500);

        if (!isRetryable || attempt === maxAttempts) break;

        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn("Dropbox API error, retrying", {
          attempt,
          delayMs: delay,
          reason: String(err),
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  private async assertOk(res: Response, endpoint: string): Promise<void> {
    if (res.ok) return;

    const body = await res.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error_summary?: string; error?: unknown };
      detail = parsed.error_summary ?? body;
    } catch {
      // use raw body
    }

    throw new DropboxApiError(
      `Dropbox API error on ${endpoint} (${res.status}): ${detail}`,
      res.status
    );
  }

  // ── Startup health check ──────────────────────────────────────────────────

  /**
   * Validates credentials. Uses /team/get_info (no user context needed) so
   * this works with the admin client before any user is selected.
   */
  async validateCredentials(): Promise<{ teamName: string }> {
    const info = await this.callApi<DropboxTeamInfo>("/team/get_info");
    return { teamName: info.name };
  }
}

export class DropboxApiError extends Error {
  public statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "DropboxApiError";
    this.statusCode = statusCode;
  }
}
