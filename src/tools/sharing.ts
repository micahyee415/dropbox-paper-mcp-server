/**
 * Dropbox sharing tools.
 *
 * Tools:
 *   create_shared_link   — create a public or team-only shared link
 *   list_shared_links    — list shared links for a file or folder
 *   revoke_shared_link   — remove a shared link
 *   add_file_member      — share a file with specific users (by email)
 *   list_file_members    — see who has access to a file
 *   remove_file_member   — revoke a user's access to a file
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DropboxClient } from "../dropbox-client.js";
import { logger } from "../logger.js";

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function toolOk(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

export function registerSharingTools(
  server: McpServer,
  client: DropboxClient,
  requestId: string,
  userEmail: string
): void {

  // ── create_shared_link ──────────────────────────────────────────────────────

  server.tool(
    "create_shared_link",
    "Create a shared link for a file or folder. By default creates a public link. " +
    "Can set access level (public or team-only) and expiry. " +
    "If a link already exists for this path, this tool returns an error — use list_shared_links to retrieve it.",
    {
      path: z.string().describe("Full Dropbox path of the file or folder to share."),
      access: z.enum(["public", "team_only"]).default("public").describe(
        "'public' — anyone with the link can view. " +
        "'team_only' — only team members with the link can view."
      ),
      allow_download: z.boolean().default(true).describe(
        "Whether recipients can download the file (vs. view-only)."
      ),
      expires: z.string().optional().describe(
        "Optional expiry datetime in ISO 8601 format (e.g. '2026-12-31T23:59:59Z'). " +
        "Requires a Dropbox Business account."
      ),
    },
    async ({ path, access, allow_download, expires }) => {
      logger.info("Tool invoked: create_shared_link", { requestId, userEmail, tool: "create_shared_link", dropboxPath: path, linkAccess: access, expires: expires ?? "never" });
      try {
        const settings: Record<string, unknown> = {
          requested_visibility: { ".tag": access },
          allow_download,
        };
        if (expires) settings["link_expiry"] = { ".tag": "set_expiry", expiry: expires };

        const result = await client.callApi<{ url: string; name: string; id?: string }>(
          "/sharing/create_shared_link_with_settings",
          { path, settings }
        );

        logger.info("Tool success: create_shared_link", { requestId, userEmail, tool: "create_shared_link", dropboxPath: path, sharedUrl: result.url, linkAccess: access, expires: expires ?? "never", outcome: "success", event: "shared_link_created" });
        return toolOk({
          message: "Shared link created.",
          url: result.url,
          name: result.name,
          access,
          allow_download,
          expires: expires ?? "never",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Dropbox returns a specific error if a link already exists — surface it helpfully
        if (msg.includes("shared_link_already_exists")) {
          logger.warn("Tool error: create_shared_link — already exists", { requestId, userEmail, tool: "create_shared_link", dropboxPath: path, outcome: "error" });
          return toolError(
            "A shared link already exists for this path. Use list_shared_links to retrieve it."
          );
        }
        logger.warn("Tool error: create_shared_link", { requestId, userEmail, tool: "create_shared_link", dropboxPath: path, outcome: "error", reason: msg });
        return toolError(msg);
      }
    }
  );

  // ── list_shared_links ───────────────────────────────────────────────────────

  server.tool(
    "list_shared_links",
    "List all shared links for a specific file or folder. " +
    "Omit path to list all shared links in the account. " +
    "Note: direct_only=true (default) only returns links created directly on the path — " +
    "set direct_only=false to also include links on parent folders that cover this file.",
    {
      path: z.string().optional().describe(
        "Full Dropbox path to list links for. Omit to list all shared links in the account."
      ),
      direct_only: z.boolean().default(true).describe(
        "If true, only return links directly on the specified path (not inherited from parent folders)."
      ),
      cursor: z.string().optional().describe(
        "Pagination cursor from a previous list_shared_links call with has_more=true."
      ),
    },
    async ({ path, direct_only, cursor }) => {
      logger.info("Tool invoked: list_shared_links", { requestId, userEmail, tool: "list_shared_links", dropboxPath: path ?? "/" });
      try {
        let result: { links: Array<Record<string, unknown>>; has_more: boolean; cursor?: string };

        if (cursor) {
          result = await client.callApi("/sharing/list_shared_links", { cursor });
        } else {
          const body: Record<string, unknown> = { direct_only };
          if (path) body["path"] = path;
          result = await client.callApi("/sharing/list_shared_links", body);
        }

        const links = result.links.map((l) => ({
          url: l["url"],
          name: l["name"],
          path: l["path_display"] ?? l["path_lower"],
          expires: l["expires"] ?? "never",
          link_type: (l["link_permissions"] as Record<string, unknown>)?.[".tag"] ?? "unknown",
        }));

        logger.info("Tool success: list_shared_links", { requestId, userEmail, tool: "list_shared_links", dropboxPath: path ?? "/", outcome: "success" });
        return toolOk({
          link_count: links.length,
          has_more: result.has_more,
          cursor: result.has_more ? result.cursor : undefined,
          links,
        });
      } catch (err) {
        logger.warn("Tool error: list_shared_links", { requestId, userEmail, tool: "list_shared_links", dropboxPath: path ?? "/", outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── revoke_shared_link ──────────────────────────────────────────────────────

  server.tool(
    "revoke_shared_link",
    "Revoke (delete) a shared link. Anyone with the old URL will no longer have access. " +
    "Use list_shared_links to find the URL to revoke.",
    {
      url: z.string().url().describe("The shared link URL to revoke."),
    },
    async ({ url }) => {
      logger.info("Tool invoked: revoke_shared_link", { requestId, userEmail, tool: "revoke_shared_link", sharedUrl: url });
      try {
        await client.callApi<Record<string, unknown>>(
          "/sharing/revoke_shared_link",
          { url }
        );
        logger.info("Tool success: revoke_shared_link", { requestId, userEmail, tool: "revoke_shared_link", sharedUrl: url, outcome: "success", event: "shared_link_revoked" });
        return toolOk({
          message: "Shared link revoked. The URL is no longer accessible.",
          revoked_url: url,
        });
      } catch (err) {
        logger.warn("Tool error: revoke_shared_link", { requestId, userEmail, tool: "revoke_shared_link", sharedUrl: url, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── add_file_member ─────────────────────────────────────────────────────────

  server.tool(
    "add_file_member",
    "Share a file with specific users by email address. " +
    "Sets their access level (viewer or editor). Optionally sends a notification email.",
    {
      path: z.string().describe("Full Dropbox path of the file to share."),
      emails: z.array(z.string().email()).min(1).describe(
        "List of email addresses to share with."
      ),
      access_level: z.enum(["viewer", "editor", "viewer_no_comment"]).default("viewer").describe(
        "'viewer' — can view and comment. " +
        "'editor' — can view, comment, and edit. " +
        "'viewer_no_comment' — can only view."
      ),
      message: z.string().optional().describe(
        "Optional message to include in the notification email sent to recipients."
      ),
      quiet: z.boolean().default(false).describe(
        "If true, suppresses the email notification to the added members."
      ),
    },
    async ({ path, emails, access_level, message, quiet }) => {
      logger.info("Tool invoked: add_file_member", { requestId, userEmail, tool: "add_file_member", dropboxPath: path, targetEmails: emails, accessLevel: access_level, event: "file_shared" });
      try {
        const members = emails.map((email) => ({
          member: { ".tag": "email", email },
          access_level: { ".tag": access_level },
        }));

        const result = await client.callApi<Array<Record<string, unknown>>>(
          "/sharing/add_file_member",
          {
            file: path,
            members,
            ...(message ? { custom_message: message } : {}),
            quiet,
          }
        );

        // result is an array of per-member results
        const outcomes = result.map((r) => ({
          member: (r["member"] as Record<string, unknown>)?.["email"] ?? "unknown",
          result: (r["result"] as Record<string, unknown>)?.[".tag"] ?? r,
        }));

        logger.info("Tool success: add_file_member", { requestId, userEmail, tool: "add_file_member", dropboxPath: path, targetEmails: emails, accessLevel: access_level, outcome: "success", event: "file_shared" });
        return toolOk({
          message: `Shared with ${emails.length} user(s).`,
          results: outcomes,
        });
      } catch (err) {
        logger.warn("Tool error: add_file_member", { requestId, userEmail, tool: "add_file_member", dropboxPath: path, targetEmails: emails, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── list_file_members ───────────────────────────────────────────────────────

  server.tool(
    "list_file_members",
    "List all users who have access to a file — both direct members and invitees. " +
    "Shows each person's access level (viewer/editor) and whether the permission is inherited.",
    {
      path: z.string().describe("Full Dropbox path of the file."),
      limit: z.number().int().min(1).max(300).default(100).describe(
        "Max results to return (1–300)."
      ),
    },
    async ({ path, limit }) => {
      logger.info("Tool invoked: list_file_members", { requestId, userEmail, tool: "list_file_members", dropboxPath: path });
      try {
        const result = await client.callApi<{
          users: Array<Record<string, unknown>>;
          groups: Array<Record<string, unknown>>;
          invitees: Array<Record<string, unknown>>;
          cursor?: string;
        }>("/sharing/list_file_members", { file: path, limit });

        const users = result.users.map((u) => ({
          type: "user",
          email: (u["user"] as Record<string, unknown>)?.["email"] ?? "unknown",
          display_name: (u["user"] as Record<string, unknown>)?.["display_name"] ?? "unknown",
          access_level: (u["access_type"] as Record<string, unknown>)?.[".tag"] ?? "unknown",
          is_inherited: u["is_inherited"],
        }));

        const invitees = result.invitees.map((i) => ({
          type: "invitee",
          email: (i["invitee"] as Record<string, unknown>)?.["email"] ?? "unknown",
          access_level: (i["access_type"] as Record<string, unknown>)?.[".tag"] ?? "unknown",
          is_inherited: i["is_inherited"],
        }));

        logger.info("Tool success: list_file_members", { requestId, userEmail, tool: "list_file_members", dropboxPath: path, outcome: "success" });
        return toolOk({
          path,
          member_count: users.length + invitees.length,
          members: [...users, ...invitees],
          groups: result.groups.length,
        });
      } catch (err) {
        logger.warn("Tool error: list_file_members", { requestId, userEmail, tool: "list_file_members", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── remove_file_member ──────────────────────────────────────────────────────

  server.tool(
    "remove_file_member",
    "Remove a user's access to a file. The user will lose their direct permission " +
    "(they may still have access if they're in a shared folder that includes the file).",
    {
      path: z.string().describe("Full Dropbox path of the file."),
      email: z.string().email().describe("Email address of the user to remove."),
    },
    async ({ path, email }) => {
      logger.info("Tool invoked: remove_file_member", { requestId, userEmail, tool: "remove_file_member", dropboxPath: path, targetEmails: [email], event: "file_access_removed" });
      try {
        await client.callApi<Record<string, unknown>>(
          "/sharing/remove_file_member_2",
          {
            file: path,
            member: { ".tag": "email", email },
          }
        );
        logger.info("Tool success: remove_file_member", { requestId, userEmail, tool: "remove_file_member", dropboxPath: path, targetEmails: [email], outcome: "success", event: "file_access_removed" });
        return toolOk({
          message: `Removed ${email}'s access to ${path}.`,
        });
      } catch (err) {
        logger.warn("Tool error: remove_file_member", { requestId, userEmail, tool: "remove_file_member", dropboxPath: path, targetEmails: [email], outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
