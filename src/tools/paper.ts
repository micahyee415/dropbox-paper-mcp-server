/**
 * Dropbox Paper document tools.
 *
 * Paper docs live in the Dropbox filesystem as .paper files.
 * They use the /files/paper/* endpoints for create/update,
 * /files/export for reading content, and /files/search_v2
 * (with file_categories: ["paper"]) for listing.
 *
 * Tools:
 *   list_paper_docs    — find all Paper documents in Dropbox
 *   create_paper_doc   — create a new Paper document from Markdown or HTML
 *   update_paper_doc   — update an existing Paper document (append/prepend/overwrite)
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

export function registerPaperTools(
  server: McpServer,
  client: DropboxClient,
  requestId: string,
  userEmail: string
): void {

  // ── list_paper_docs ─────────────────────────────────────────────────────────

  server.tool(
    "list_paper_docs",
    "Find all Dropbox Paper documents in your Dropbox. Optionally search by title keyword " +
    "or restrict to a specific folder. Returns file paths, modification dates, and IDs. " +
    "To read a Paper doc's content, use export_file with the returned path.",
    {
      query: z.string().default("").describe(
        "Optional keyword to filter by title. Leave empty to list all Paper docs."
      ),
      path: z.string().default("").describe(
        "Restrict to a specific folder path (e.g. '/Engineering'). Leave empty to search all of Dropbox."
      ),
      limit: z.number().int().min(1).max(100).default(50).describe(
        "Max results to return (1–100)."
      ),
      cursor: z.string().optional().describe(
        "Pagination cursor from a previous list_paper_docs call with has_more=true. " +
        "When provided, all other parameters are ignored — the cursor encodes all search state."
      ),
    },
    async ({ query, path, limit, cursor }) => {
      logger.info("Tool invoked: list_paper_docs", { requestId, userEmail, tool: "list_paper_docs", searchQuery: query || "(all)", searchFolder: path || "/" });
      try {
        // Use search_v2 with the 'paper' file category to find all Paper docs
        let result: { matches: Array<{ metadata: { metadata: Record<string, unknown> } }>; has_more: boolean; cursor?: string };

        if (cursor) {
          result = await client.callApi("/files/search/continue_v2", { cursor });
        } else {
          result = await client.callApi("/files/search_v2", {
            // An empty query isn't allowed by Dropbox — use a space if no keyword provided
            query: query.trim() || " ",
            options: {
              path: path === "/" ? "" : path,
              max_results: limit,
              file_categories: ["paper"],
              filename_only: !query.trim(), // only search filenames when no query
            },
          });
        }

        const docs = result.matches.map((m) => {
          const meta = m.metadata.metadata;
          return {
            name: meta["name"],
            path: meta["path_display"],
            id: meta["id"],
            modified: meta["server_modified"] ?? meta["client_modified"],
            size: meta["size"],
          };
        });

        logger.info("Tool success: list_paper_docs", { requestId, userEmail, tool: "list_paper_docs", searchQuery: query || "(all)", searchFolder: path || "/", outcome: "success" });
        return toolOk({
          paper_doc_count: docs.length,
          has_more: result.has_more,
          cursor: result.has_more ? result.cursor : undefined,
          note: "To read a doc's content, use export_file with the path.",
          docs,
        });
      } catch (err) {
        logger.warn("Tool error: list_paper_docs", { requestId, userEmail, tool: "list_paper_docs", searchQuery: query, searchFolder: path || "/", outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── create_paper_doc ────────────────────────────────────────────────────────

  server.tool(
    "create_paper_doc",
    "Create a new Dropbox Paper document. The path should end in '.paper'. " +
    "Provide content as Markdown (recommended) or HTML. " +
    "Returns the new document's path, ID, and URL.",
    {
      path: z.string().describe(
        "Full Dropbox path for the new Paper doc, ending in '.paper' " +
        "(e.g. '/Engineering/Playbooks/onboarding.paper')."
      ),
      content: z.string().describe(
        "Document content. Markdown is recommended for readability. " +
        "HTML is also supported if you need to preserve rich formatting."
      ),
      import_format: z.enum(["markdown", "html", "plain_text"]).default("markdown").describe(
        "Format of the content: 'markdown' (default), 'html', or 'plain_text'."
      ),
    },
    async ({ path, content, import_format }) => {
      logger.info("Tool invoked: create_paper_doc", { requestId, userEmail, tool: "create_paper_doc", dropboxPath: path });
      try {
        // Paper create uses the Content API: args in Dropbox-API-Arg header, content in body
        const meta = await client.uploadContent<Record<string, unknown>>(
          "/files/paper/create",
          { path, import_format },
          content
        );

        logger.info("Tool success: create_paper_doc", { requestId, userEmail, tool: "create_paper_doc", dropboxPath: path, outcome: "success" });
        return toolOk({
          message: "Paper document created successfully.",
          doc: {
            name: meta["name"],
            path: meta["path_display"],
            id: meta["id"],
            url: meta["url"],
            paper_revision: meta["paper_revision"],
          },
        });
      } catch (err) {
        logger.warn("Tool error: create_paper_doc", { requestId, userEmail, tool: "create_paper_doc", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ── update_paper_doc ────────────────────────────────────────────────────────

  server.tool(
    "update_paper_doc",
    "Update an existing Dropbox Paper document. Can append to the end, prepend to the beginning, " +
    "or completely overwrite the content. To read the current content first, use export_file.",
    {
      path: z.string().describe(
        "Full Dropbox path to the existing Paper doc (e.g. '/Engineering/Playbooks/onboarding.paper')."
      ),
      content: z.string().describe(
        "New content to apply. For 'overwrite_all', this replaces the entire document. " +
        "For 'append'/'prepend', this is added to the existing content."
      ),
      doc_update_policy: z.enum(["overwrite_all", "append", "prepend", "update"]).default("overwrite_all").describe(
        "'overwrite_all' — replace entire doc (most common). " +
        "'append' — add content to the end. " +
        "'prepend' — add content to the beginning. " +
        "'update' — overwrites but requires paper_revision to match (safe concurrent update)."
      ),
      import_format: z.enum(["markdown", "html", "plain_text"]).default("markdown").describe(
        "Format of the new content."
      ),
      paper_revision: z.number().int().optional().describe(
        "Required only when doc_update_policy is 'update'. " +
        "Pass -1 to force overwrite regardless of revision. " +
        "Get the current revision from create_paper_doc or get_metadata."
      ),
    },
    async ({ path, content, doc_update_policy, import_format, paper_revision }) => {
      logger.info("Tool invoked: update_paper_doc", { requestId, userEmail, tool: "update_paper_doc", dropboxPath: path, updatePolicy: doc_update_policy });
      try {
        const args: Record<string, unknown> = {
          path,
          import_format,
          doc_update_policy: { ".tag": doc_update_policy },
        };

        // paper_revision is required for 'update' mode
        if (doc_update_policy === "update") {
          args["paper_revision"] = paper_revision ?? -1;
        }

        const meta = await client.uploadContent<Record<string, unknown>>(
          "/files/paper/update",
          args,
          content
        );

        logger.info("Tool success: update_paper_doc", { requestId, userEmail, tool: "update_paper_doc", dropboxPath: path, updatePolicy: doc_update_policy, outcome: "success" });
        return toolOk({
          message: "Paper document updated successfully.",
          doc: {
            name: meta["name"],
            path: meta["path_display"],
            id: meta["id"],
            paper_revision: meta["paper_revision"],
          },
        });
      } catch (err) {
        logger.warn("Tool error: update_paper_doc", { requestId, userEmail, tool: "update_paper_doc", dropboxPath: path, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
