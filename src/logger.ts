/**
 * Structured JSON logger for Cloud Run.
 *
 * Writes to stderr — Cloud Logging picks this up automatically and indexes
 * the fields, making them searchable/filterable in the GCP console.
 *
 * Log fields surfaced in Cloud Logging:
 *   severity     — DEBUG / INFO / WARNING / ERROR (filterable)
 *   message      — human-readable description
 *   timestamp    — ISO 8601
 *   requestId    — per-request UUID for correlating all log lines from one call
 *   userEmail    — who triggered the request (SOC 2 audit trail)
 *   tool         — which MCP tool was called
 *   durationMs   — how long the request took
 *   statusCode   — HTTP response code
 *   args         — sanitized tool arguments (paths, doc IDs, query terms, etc.)
 *   outcome      — "success" | "error" | "rate_limited" | "auth_failure"
 *   dropboxPath  — file/folder path accessed or modified (audit trail key field)
 *   fromPath     — source path for move/copy operations
 *   toPath       — destination path for move/copy operations
 *   sharedUrl    — shared link URL created or revoked
 *   targetEmails — emails added/removed for file-member sharing operations
 *   searchQuery  — search term used in search_files / list_paper_docs
 *   retryAttempt — which retry attempt (for Dropbox API retries)
 */

type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface LogFields {
  // Core identity / correlation
  requestId?: string;
  userEmail?: string;
  tool?: string;
  // Timing and status
  durationMs?: number;
  statusCode?: number;
  outcome?: "success" | "error" | "rate_limited" | "auth_failure" | "not_found";
  // Audit trail — file paths and identifiers
  dropboxPath?: string;      // primary path (read, write, delete, metadata ops)
  fromPath?: string;         // source path for move_file / copy_file
  toPath?: string;           // destination path for move_file / copy_file
  sharedUrl?: string;        // URL created or revoked in sharing ops
  targetEmails?: string[];   // emails in add_file_member / remove_file_member
  // Search / listing context
  searchQuery?: string;      // query term for search_files / list_paper_docs
  searchFolder?: string;     // folder restriction for search ops
  // Error and event metadata
  reason?: string;
  event?: string;
  retryAttempt?: number;
  [key: string]: unknown;
}

function write(severity: Severity, message: string, fields?: LogFields): void {
  console.error(
    JSON.stringify({
      severity,
      message,
      timestamp: new Date().toISOString(),
      ...fields,
    })
  );
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write("DEBUG",   message, fields),
  info:  (message: string, fields?: LogFields) => write("INFO",    message, fields),
  warn:  (message: string, fields?: LogFields) => write("WARNING", message, fields),
  error: (message: string, fields?: LogFields) => write("ERROR",   message, fields),
};
