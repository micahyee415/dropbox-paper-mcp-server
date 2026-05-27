/**
 * Dropbox file and folder tools.
 *
 * Tools:
 *   list_folder          — list folder contents with pagination
 *   get_metadata         — get file or folder metadata
 *   search_files         — search by name or content keyword
 *   download_file        — get text file content
 *   get_temporary_link   — get a temporary download URL (for binary files)
 *   upload_file          — create or overwrite a file with text content
 *   create_folder        — create a new folder
 *   move_file            — move or rename a file/folder
 *   copy_file            — copy a file or folder
 *   delete_file          — move a file/folder to trash
 *   permanently_delete_file — permanently delete (no recovery)
 *   list_revisions       — list file revision history
 *   restore_revision     — restore a file to a specific revision
 *   export_file          — export a Paper doc or Office file as text/markdown/html
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DropboxClient, DropboxApiError } from "../dropbox-client.js";
import { logger } from "../logger.js";

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function toolOk(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

export function registerFileTools(
  server: McpServer,
  client: DropboxClient,
  requestId: string,
  userEmail: string
): void {

  // ── list_folder ─────────────────────────────────────────────────────────────

  server.tool(
    "list_folder",
    "List the contents of a Dropbox folder. Returns files and subfolders with metadata. " +
    "Use path '/' or '' for the root. Use cursor from previous result to paginate.",
    {
      path: z.string().default("").describe(
        "Folder path to list (e.g. '/Engineering/Playbooks'). Use '' for Dropbox root."
      ),
      recursive: z.boolean().default(false).describe(
        "If true, recursively list all subfolders. Use with caution on large trees."
      ),
      limit: z.number().int().min(1).max(2000).default(100).describe(
        "Max entries to return per call (1–2000). Use cursor to get next page."
      ),
      cursor: z.string().optional().describe(
        "Pagination cursor from a previous list_folder call. Omit for first page."
      ),
    },
    async ({ path, recursive, limit, cursor }) => {
      logger.info("Tool invoked: list_folder", { requestId, userEmail, tool: "list_folder", dropboxPath: path || "/" });
      try {
        let result;
        if (cursor) {
          result = await client.callApi<{
            entries: unknown[];
            cursor: string;
            has_more: boolean;
          }>("/files/list_folder/continue", { cursor });
        } else {
          result = await client.callApi<{
            entries: unknown[];
            cursor: string;
            has_more: boolean;
          }>("/files/list_folder", {
            path: path === "/" ? "" : path,
            recursive,
            limit,
            include_media_info: false,
            include_deleted: false,
            include_has_explicit_shared_members: false,
          });
        }

        const summary = {
          entry_count: result.entries.length,
          has_more: result.has_more,
          cursor: result.has_more ? result.cursor : undefined,
          entries: result.entries.map((e: unknown) => {
            const entry = e as Record<string, unknown>;
            return {
              type: entry[".tag"],
              name: entry["name"],
              path: entry["path_display"],
              size: entry["size"],
              modified: entry["server_modified"] ?? entry["client_modified"],
              id: entry["id"],
            };
          }),
        };

        logger.info("Tool success: list_folder", { requestId, userEmail, tool: "list_folder", dropboxPath: path || "/", outcome: "success" });
        return toolOk(summary);
      } catch (err) {
        logger.warn("Tool error: list_folder", { requestId, userEmail, tool: "list_folder", dropboxPath: path || "/", outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── get_metadata ────────────────────────────────────────────────────────────

  server.tool(
    "get_metadata",
    "Get detailed metadata for a file or folder: size, modified date, ID, revision, " +
    "whether it's a Paper doc (is_downloadable=false + export_info), etc.",
    {
      path: z.string().describe(
        "Full Dropbox path (e.g. '/Engineering/Playbooks/onboarding.paper')."
      ),
    },
    async ({ path }) => {
      logger.info("Tool invoked: get_metadata", { requestId, userEmail, tool: "get_metadata", dropboxPath: path });
      try {
        const meta = await client.callApi<Record<string, unknown>>(
          "/files/get_metadata",
          { path, include_media_info: false, include_deleted: false }
        );
        logger.info("Tool success: get_metadata", { requestId, userEmail, tool: "get_metadata", dropboxPath: path, outcome: "success" });
        return toolOk(meta);
      } catch (err) {
        logger.warn("Tool error: get_metadata", { requestId, userEmail, tool: "get_metadata", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── search_files ────────────────────────────────────────────────────────────

  server.tool(
    "search_files",
    "Search Dropbox by filename or content keyword. Optionally filter by folder path, " +
    "file extension (e.g. 'paper', 'md', 'pdf'), or file category.",
    {
      query: z.string().describe("Search term — matches filename and file content."),
      path: z.string().default("").describe(
        "Restrict search to this folder path. Leave empty to search all of Dropbox."
      ),
      max_results: z.number().int().min(1).max(100).default(20).describe(
        "Max results to return (1–100)."
      ),
      file_extensions: z.array(z.string()).optional().describe(
        "Filter by file extensions (without dot, e.g. ['paper', 'md', 'pdf'])."
      ),
      file_categories: z.array(
        z.enum(["image", "document", "pdf", "spreadsheet", "presentation", "audio", "video", "folder", "paper", "others"])
      ).optional().describe(
        "Filter by Dropbox file categories. Use 'paper' to find Paper docs."
      ),
      filename_only: z.boolean().default(false).describe(
        "If true, only search filenames (faster). If false, also searches file content."
      ),
      cursor: z.string().optional().describe(
        "Pagination cursor from a previous search_files call with has_more=true. " +
        "When provided, all other parameters are ignored — the cursor encodes all search state."
      ),
    },
    async ({ query, path, max_results, file_extensions, file_categories, filename_only, cursor }) => {
      logger.info("Tool invoked: search_files", { requestId, userEmail, tool: "search_files", searchQuery: query, searchFolder: path || "/" });
      try {
        let result: { matches: Array<{ metadata: { metadata: Record<string, unknown> } }>; has_more: boolean; cursor?: string };

        if (cursor) {
          result = await client.callApi("/files/search/continue_v2", { cursor });
        } else {
          const options: Record<string, unknown> = {
            path: path === "/" ? "" : path,
            max_results,
            filename_only,
          };
          if (file_extensions?.length) options["file_extensions"] = file_extensions;
          if (file_categories?.length) options["file_categories"] = file_categories;
          result = await client.callApi("/files/search_v2", { query, options });
        }

        const matches = result.matches.map((m) => {
          const meta = m.metadata.metadata;
          return {
            type: meta[".tag"],
            name: meta["name"],
            path: meta["path_display"],
            size: meta["size"],
            modified: meta["server_modified"] ?? meta["client_modified"],
          };
        });

        logger.info("Tool success: search_files", { requestId, userEmail, tool: "search_files", searchQuery: query, searchFolder: path || "/", outcome: "success" });
        return toolOk({
          result_count: matches.length,
          has_more: result.has_more,
          cursor: result.has_more ? result.cursor : undefined,
          results: matches,
        });
      } catch (err) {
        logger.warn("Tool error: search_files", { requestId, userEmail, tool: "search_files", searchQuery: query, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── download_file ───────────────────────────────────────────────────────────

  server.tool(
    "download_file",
    "Download and return the text content of a file. Best for plain text, Markdown, " +
    "JSON, YAML, code files, etc. For Paper docs use export_file instead (returns cleaner Markdown). " +
    "For binary files (images, PDFs) use get_temporary_link to get a download URL.",
    {
      path: z.string().describe("Full Dropbox path to the file."),
    },
    async ({ path }) => {
      logger.info("Tool invoked: download_file", { requestId, userEmail, tool: "download_file", dropboxPath: path });
      try {
        const { content, metadata } = await client.downloadContent("/files/download", { path });
        const meta = metadata as Record<string, unknown>;
        const header = `File: ${String(meta["path_display"] ?? path)}\nSize: ${String(meta["size"] ?? "unknown")} bytes\nModified: ${String(meta["server_modified"] ?? "unknown")}\n\n---\n\n`;
        logger.info("Tool success: download_file", { requestId, userEmail, tool: "download_file", dropboxPath: path, outcome: "success" });
        return toolOk(header + content);
      } catch (err) {
        if (err instanceof DropboxApiError && err.statusCode === 409) {
          logger.warn("Tool error: download_file — unsupported type", { requestId, userEmail, tool: "download_file", dropboxPath: path, outcome: "error" });
          return toolError(
            "Cannot download this file type as text. " +
            "For Paper docs, use export_file. For binary files, use get_temporary_link."
          );
        }
        logger.warn("Tool error: download_file", { requestId, userEmail, tool: "download_file", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── get_temporary_link ──────────────────────────────────────────────────────

  server.tool(
    "get_temporary_link",
    "Get a time-limited direct download URL for any file (valid for ~4 hours). " +
    "Use this for binary files like images, PDFs, and videos that can't be read as text.",
    {
      path: z.string().describe("Full Dropbox path to the file."),
    },
    async ({ path }) => {
      logger.info("Tool invoked: get_temporary_link", { requestId, userEmail, tool: "get_temporary_link", dropboxPath: path });
      try {
        const result = await client.callApi<{ link: string; metadata: Record<string, unknown> }>(
          "/files/get_temporary_link",
          { path }
        );
        logger.info("Tool success: get_temporary_link", { requestId, userEmail, tool: "get_temporary_link", dropboxPath: path, outcome: "success" });
        return toolOk({
          download_url: result.link,
          expires_in: "~4 hours",
          file: {
            name: result.metadata["name"],
            path: result.metadata["path_display"],
            size: result.metadata["size"],
          },
        });
      } catch (err) {
        logger.warn("Tool error: get_temporary_link", { requestId, userEmail, tool: "get_temporary_link", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── upload_file ─────────────────────────────────────────────────────────────

  server.tool(
    "upload_file",
    "Upload text content as a file to Dropbox. Creates new files or updates existing ones. " +
    "For creating Paper documents, use create_paper_doc instead.",
    {
      path: z.string().describe(
        "Full Dropbox path where the file should be saved (e.g. '/Engineering/notes.md')."
      ),
      content: z.string().describe("Text content to write to the file."),
      mode: z.enum(["add", "overwrite", "update"]).default("add").describe(
        "'add' creates a new file (autorenames if exists). " +
        "'overwrite' replaces an existing file. " +
        "'update' overwrites only if the rev matches."
      ),
      autorename: z.boolean().default(true).describe(
        "If true and path already exists in 'add' mode, Dropbox renames the new file automatically."
      ),
    },
    async ({ path, content, mode, autorename }) => {
      logger.info("Tool invoked: upload_file", { requestId, userEmail, tool: "upload_file", dropboxPath: path, uploadMode: mode });
      try {
        const args: Record<string, unknown> = { path, mode: { ".tag": mode }, autorename, mute: false };
        const meta = await client.uploadContent<Record<string, unknown>>(
          "/files/upload",
          args,
          content
        );
        logger.info("Tool success: upload_file", { requestId, userEmail, tool: "upload_file", dropboxPath: path, uploadMode: mode, outcome: "success" });
        return toolOk({
          message: "File uploaded successfully.",
          file: {
            name: meta["name"],
            path: meta["path_display"],
            size: meta["size"],
            modified: meta["server_modified"],
            id: meta["id"],
          },
        });
      } catch (err) {
        logger.warn("Tool error: upload_file", { requestId, userEmail, tool: "upload_file", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── create_folder ───────────────────────────────────────────────────────────

  server.tool(
    "create_folder",
    "Create a new folder in Dropbox. Parent folders must already exist.",
    {
      path: z.string().describe(
        "Full path for the new folder (e.g. '/Engineering/Playbooks/2026')."
      ),
      autorename: z.boolean().default(false).describe(
        "If true and the folder already exists, creates a renamed version instead of erroring."
      ),
    },
    async ({ path, autorename }) => {
      logger.info("Tool invoked: create_folder", { requestId, userEmail, tool: "create_folder", dropboxPath: path });
      try {
        const result = await client.callApi<{ metadata: Record<string, unknown> }>(
          "/files/create_folder_v2",
          { path, autorename }
        );
        const meta = result.metadata;
        logger.info("Tool success: create_folder", { requestId, userEmail, tool: "create_folder", dropboxPath: path, outcome: "success" });
        return toolOk({
          message: "Folder created successfully.",
          folder: { name: meta["name"], path: meta["path_display"], id: meta["id"] },
        });
      } catch (err) {
        logger.warn("Tool error: create_folder", { requestId, userEmail, tool: "create_folder", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── move_file ───────────────────────────────────────────────────────────────

  server.tool(
    "move_file",
    "Move or rename a file or folder. This is the same operation — change the path to rename, " +
    "or change the parent folder to move.",
    {
      from_path: z.string().describe("Current full Dropbox path."),
      to_path: z.string().describe("Destination full Dropbox path."),
      autorename: z.boolean().default(false).describe(
        "If true and destination exists, auto-rename instead of erroring."
      ),
      allow_ownership_transfer: z.boolean().default(false).describe(
        "Required if moving into a folder with a different owner."
      ),
    },
    async ({ from_path, to_path, autorename, allow_ownership_transfer }) => {
      logger.info("Tool invoked: move_file", { requestId, userEmail, tool: "move_file", fromPath: from_path, toPath: to_path });
      try {
        const result = await client.callApi<{ metadata: Record<string, unknown> }>(
          "/files/move_v2",
          { from_path, to_path, autorename, allow_ownership_transfer }
        );
        const meta = result.metadata;
        logger.info("Tool success: move_file", { requestId, userEmail, tool: "move_file", fromPath: from_path, toPath: to_path, outcome: "success" });
        return toolOk({
          message: "Moved successfully.",
          item: { name: meta["name"], path: meta["path_display"], type: meta[".tag"] },
        });
      } catch (err) {
        logger.warn("Tool error: move_file", { requestId, userEmail, tool: "move_file", fromPath: from_path, toPath: to_path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── copy_file ───────────────────────────────────────────────────────────────

  server.tool(
    "copy_file",
    "Copy a file or folder to a new Dropbox path. The original is preserved.",
    {
      from_path: z.string().describe("Source full Dropbox path."),
      to_path: z.string().describe("Destination full Dropbox path."),
      autorename: z.boolean().default(false).describe(
        "If true and destination exists, auto-rename instead of erroring."
      ),
    },
    async ({ from_path, to_path, autorename }) => {
      logger.info("Tool invoked: copy_file", { requestId, userEmail, tool: "copy_file", fromPath: from_path, toPath: to_path });
      try {
        const result = await client.callApi<{ metadata: Record<string, unknown> }>(
          "/files/copy_v2",
          { from_path, to_path, autorename }
        );
        const meta = result.metadata;
        logger.info("Tool success: copy_file", { requestId, userEmail, tool: "copy_file", fromPath: from_path, toPath: to_path, outcome: "success" });
        return toolOk({
          message: "Copied successfully.",
          item: { name: meta["name"], path: meta["path_display"], type: meta[".tag"] },
        });
      } catch (err) {
        logger.warn("Tool error: copy_file", { requestId, userEmail, tool: "copy_file", fromPath: from_path, toPath: to_path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── delete_file ─────────────────────────────────────────────────────────────

  server.tool(
    "delete_file",
    "Move a file or folder to the Dropbox trash. Recoverable for 180 days. " +
    "To permanently delete with no recovery possible, use permanently_delete_file.",
    {
      path: z.string().describe("Full Dropbox path of the file or folder to delete."),
    },
    async ({ path }) => {
      logger.info("Tool invoked: delete_file", { requestId, userEmail, tool: "delete_file", dropboxPath: path });
      try {
        const result = await client.callApi<{ metadata: Record<string, unknown> }>(
          "/files/delete_v2",
          { path }
        );
        const meta = result.metadata;
        logger.info("Tool success: delete_file", { requestId, userEmail, tool: "delete_file", dropboxPath: path, outcome: "success" });
        return toolOk({
          message: `Moved to trash: ${String(meta["path_display"] ?? path)}`,
          note: "Recoverable from Dropbox trash for 180 days.",
        });
      } catch (err) {
        logger.warn("Tool error: delete_file", { requestId, userEmail, tool: "delete_file", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── permanently_delete_file ─────────────────────────────────────────────────

  server.tool(
    "permanently_delete_file",
    "PERMANENTLY delete a file or folder from Dropbox. This cannot be undone — " +
    "the item will not appear in trash and cannot be recovered. " +
    "Prefer delete_file (soft delete) unless permanent removal is specifically required.",
    {
      path: z.string().describe("Full Dropbox path of the file or folder to permanently delete."),
    },
    async ({ path }) => {
      // Use ERROR level for permanent deletes — always audit-trail worthy
      logger.error("Tool invoked: permanently_delete_file — IRREVERSIBLE ACTION", { requestId, userEmail, tool: "permanently_delete_file", dropboxPath: path, event: "permanent_delete" });
      try {
        await client.callApi<Record<string, unknown>>(
          "/files/permanently_delete",
          { path }
        );
        logger.error("Tool success: permanently_delete_file", { requestId, userEmail, tool: "permanently_delete_file", dropboxPath: path, outcome: "success", event: "permanent_delete" });
        return toolOk({
          message: `Permanently deleted: ${path}`,
          warning: "This action cannot be undone.",
        });
      } catch (err) {
        logger.warn("Tool error: permanently_delete_file", { requestId, userEmail, tool: "permanently_delete_file", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── list_revisions ──────────────────────────────────────────────────────────

  server.tool(
    "list_revisions",
    "List the revision history of a file. Each revision has a rev ID that can be " +
    "used with restore_revision to roll back to a previous version.",
    {
      path: z.string().describe("Full Dropbox path of the file."),
      limit: z.number().int().min(1).max(100).default(10).describe(
        "Number of revisions to return (1–100, newest first)."
      ),
    },
    async ({ path, limit }) => {
      logger.info("Tool invoked: list_revisions", { requestId, userEmail, tool: "list_revisions", dropboxPath: path });
      try {
        const result = await client.callApi<{
          is_deleted: boolean;
          entries: Array<Record<string, unknown>>;
        }>("/files/list_revisions", { path, mode: { ".tag": "path" }, limit });

        const revisions = result.entries.map((e) => ({
          rev: e["rev"],
          size: e["size"],
          modified: e["server_modified"],
          is_current: e["rev"] === result.entries[0]?.["rev"],
        }));

        logger.info("Tool success: list_revisions", { requestId, userEmail, tool: "list_revisions", dropboxPath: path, outcome: "success" });
        return toolOk({
          path,
          is_deleted: result.is_deleted,
          revision_count: revisions.length,
          revisions,
        });
      } catch (err) {
        logger.warn("Tool error: list_revisions", { requestId, userEmail, tool: "list_revisions", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── restore_revision ────────────────────────────────────────────────────────

  server.tool(
    "restore_revision",
    "Restore a file to a specific revision. Use list_revisions to find the rev ID. " +
    "The current version is overwritten with the selected revision.",
    {
      path: z.string().describe("Full Dropbox path of the file to restore."),
      rev: z.string().describe("Revision ID to restore to (from list_revisions)."),
    },
    async ({ path, rev }) => {
      logger.info("Tool invoked: restore_revision", { requestId, userEmail, tool: "restore_revision", dropboxPath: path, revisionId: rev });
      try {
        const meta = await client.callApi<Record<string, unknown>>(
          "/files/restore",
          { path, rev }
        );
        logger.info("Tool success: restore_revision", { requestId, userEmail, tool: "restore_revision", dropboxPath: path, revisionId: rev, outcome: "success" });
        return toolOk({
          message: `File restored to revision ${rev}.`,
          file: {
            name: meta["name"],
            path: meta["path_display"],
            size: meta["size"],
            modified: meta["server_modified"],
          },
        });
      } catch (err) {
        logger.warn("Tool error: restore_revision", { requestId, userEmail, tool: "restore_revision", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── export_file ─────────────────────────────────────────────────────────────

  server.tool(
    "export_file",
    "Export a Dropbox Paper document (or Office file) as text. " +
    "For Paper docs: use 'markdown' for clean text, 'html' for full formatting with links. " +
    "This is the correct way to read Paper doc content — download_file does not work on Paper files.",
    {
      path: z.string().describe(
        "Full Dropbox path to the Paper doc or Office file (e.g. '/Engineering/onboarding.paper')."
      ),
      export_format: z.enum(["markdown", "html"]).default("markdown").describe(
        "'markdown' returns clean readable text. 'html' preserves formatting, links, and tables."
      ),
    },
    async ({ path, export_format }) => {
      logger.info("Tool invoked: export_file", { requestId, userEmail, tool: "export_file", dropboxPath: path, exportFormat: export_format });
      try {
        const { content, metadata } = await client.downloadContent("/files/export", {
          path,
          export_format,
        });

        const meta = metadata as Record<string, unknown>;
        const exportMeta = (meta["export_metadata"] ?? {}) as Record<string, unknown>;

        const header =
          `# ${String(exportMeta["name"] ?? path)}\n` +
          `Exported from: ${path}\n` +
          `Format: ${export_format}\n\n---\n\n`;

        logger.info("Tool success: export_file", { requestId, userEmail, tool: "export_file", dropboxPath: path, exportFormat: export_format, outcome: "success" });
        return toolOk(header + content);
      } catch (err) {
        if (err instanceof DropboxApiError && err.statusCode === 409) {
          logger.warn("Tool error: export_file — unsupported format", { requestId, userEmail, tool: "export_file", dropboxPath: path, outcome: "error" });
          return toolError(
            "This file cannot be exported in that format. " +
            "Paper docs support 'markdown' and 'html'. Office files may only support certain formats."
          );
        }
        logger.warn("Tool error: export_file", { requestId, userEmail, tool: "export_file", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
