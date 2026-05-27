/**
 * Dropbox account tools.
 *
 * Tools:
 *   get_account_info  — current account details: name, email, team, plan
 *   get_space_usage   — storage usage breakdown (used, allocated, team quota)
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DropboxClient, DropboxAccount, DropboxSpaceUsage } from "../dropbox-client.js";
import { logger } from "../logger.js";

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function toolOk(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function registerAccountTools(
  server: McpServer,
  client: DropboxClient,
  requestId: string,
  userEmail: string
): void {

  // ── get_account_info ────────────────────────────────────────────────────────

  server.tool(
    "get_account_info",
    "Get information about the connected Dropbox account: name, email, account type " +
    "(individual or business), and team name if applicable. Also returns current storage usage.",
    {},
    async () => {
      logger.info("Tool invoked: get_account_info", { requestId, userEmail, tool: "get_account_info" });
      try {
        const [account, space] = await Promise.all([
          client.callApi<DropboxAccount>("/users/get_current_account"),
          client.callApi<DropboxSpaceUsage>("/users/get_space_usage"),
        ]);

        const used = space.used;
        const allocated = space.allocation[".tag"] === "individual"
          ? (space.allocation as { allocated: number }).allocated
          : (space.allocation as { allocated: number }).allocated;

        logger.info("Tool success: get_account_info", { requestId, userEmail, tool: "get_account_info", outcome: "success" });
        return toolOk({
          name: account.name.display_name,
          email: account.email,
          email_verified: account.email_verified,
          account_type: account.account_type[".tag"],
          team: account.team?.name ?? null,
          storage: {
            used: formatBytes(used),
            allocated: formatBytes(allocated),
            percent_used: allocated > 0 ? `${((used / allocated) * 100).toFixed(1)}%` : "N/A",
          },
          account_id: account.account_id,
        });
      } catch (err) {
        logger.warn("Tool error: get_account_info", { requestId, userEmail, tool: "get_account_info", outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── get_space_usage ─────────────────────────────────────────────────────────

  server.tool(
    "get_space_usage",
    "Get detailed Dropbox storage usage. For team accounts, shows both individual " +
    "usage and team-level quota breakdown.",
    {},
    async () => {
      logger.info("Tool invoked: get_space_usage", { requestId, userEmail, tool: "get_space_usage" });
      try {
        const space = await client.callApi<DropboxSpaceUsage>("/users/get_space_usage");

        if (space.allocation[".tag"] === "individual") {
          const alloc = space.allocation as { allocated: number };
          logger.info("Tool success: get_space_usage", { requestId, userEmail, tool: "get_space_usage", outcome: "success" });
          return toolOk({
            type: "individual",
            used: formatBytes(space.used),
            used_bytes: space.used,
            allocated: formatBytes(alloc.allocated),
            allocated_bytes: alloc.allocated,
            available: formatBytes(alloc.allocated - space.used),
            percent_used: `${((space.used / alloc.allocated) * 100).toFixed(1)}%`,
          });
        } else {
          // Team allocation
          const alloc = space.allocation as {
            used: number;
            allocated: number;
            user_within_team_space_allocated: number;
          };
          logger.info("Tool success: get_space_usage", { requestId, userEmail, tool: "get_space_usage", outcome: "success" });
          return toolOk({
            type: "team",
            personal_used: formatBytes(space.used),
            personal_used_bytes: space.used,
            team_used: formatBytes(alloc.used),
            team_allocated: formatBytes(alloc.allocated),
            team_available: formatBytes(alloc.allocated - alloc.used),
            team_percent_used: `${((alloc.used / alloc.allocated) * 100).toFixed(1)}%`,
            your_team_quota: alloc.user_within_team_space_allocated > 0
              ? formatBytes(alloc.user_within_team_space_allocated)
              : "unlimited",
          });
        }
      } catch (err) {
        logger.warn("Tool error: get_space_usage", { requestId, userEmail, tool: "get_space_usage", outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
