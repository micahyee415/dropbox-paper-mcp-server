# Dropbox MCP Server — Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.0.4] — 2026-05-12

### Security

- **OAuth audience check enforced** — `verifyGoogleToken` now validates that the token's `aud` claim matches `GOOGLE_CLIENT_ID`. Previously, any Google OAuth access token issued by any OAuth client for an allowed-domain user would authenticate, regardless of which OAuth app issued it. Closes a confused-deputy vulnerability.
- **Token cache keys are now SHA-256 hashes, not raw tokens** — the in-memory token cache previously used the raw bearer token as a `Map` key, leaving live OAuth credentials recoverable from process memory via heap or core dump. The key is now a SHA-256 hash of the token — a stable unique identifier with no way to recover the original.

---

## [1.0.3] — 2026-04-10

Replaced single hardcoded admin impersonation with per-user Dropbox identity, so each
authenticated user operates under their own Dropbox permissions. This closes the audit
gap where all activity appeared in logs as a single admin user, and removes the
over-privileged single-account access pattern.

### Changed

- **Per-user Dropbox impersonation** — each authenticated user now accesses Dropbox
  under their own identity and Dropbox permissions. Replaced the hardcoded
  `DROPBOX_SELECT_USER` admin override with a `TeamMemberCache` (`src/team-cache.ts`)
  that maps authenticated email → Dropbox `team_member_id` at startup (refreshed
  hourly). Users without a Dropbox seat receive HTTP 403.
- **`DropboxTokenManager` extracted** — token refresh logic moved out of `DropboxClient`
  into a shared singleton. Prevents redundant token refreshes across concurrent
  per-request clients. `forUser(dbmid)` returns a lightweight user-scoped client that
  reuses the shared token manager.
- **Health check updated** — now calls `/team/get_info` (a team-level endpoint requiring
  no user selection) and reports team name and cached member count, confirming both
  Dropbox connectivity and cache warm-up on startup.

### Removed

- `DROPBOX_SELECT_USER` env var — superseded by the per-user `TeamMemberCache` approach.

---

## [1.0.2] — 2026-04-10

Isolated Dropbox MCP's Google OAuth credentials from any shared project-level credentials,
to allow each service's OAuth client to be rotated or revoked independently.

### Changed

- **Dedicated Google OAuth credentials** — Dropbox MCP now uses its own Google OAuth
  client credentials stored separately in GCP Secret Manager, rather than sharing
  credentials with other services.

---

## [1.0.1] — 2026-04-10

Fixed two API compatibility bugs that prevented the server from functioning with a
Dropbox Business (team) app.

### Fixed

- **Business team token requires user selection header** — Dropbox Business apps use a
  team-scoped OAuth token; all API calls must include `Dropbox-API-Select-User` to
  specify which team member's context to use. Without this header, Dropbox rejects every
  request. Added the header to all `callApi`, `uploadContent`, and `downloadContent`
  calls using the `DROPBOX_SELECT_USER` env var.
- **No-parameter endpoints reject a non-null body** — Dropbox endpoints that take no
  request body (e.g. `/users/get_current_account`) return HTTP 400 if any body is sent.
  Fixed `callApi` to send `"null"` instead of `"{}"` for these endpoints.

### Added

- **Artifact Registry repository** — Docker image repository for the service
  (`us-central1-docker.pkg.dev/your-gcp-project/mcp-servers`) created so Cloud Build
  could push images on first deploy.

---

## [1.0.0] — 2026-04-10

Initial release of the Dropbox MCP server — a Claude-native integration for Dropbox
Business, deployed on GCP Cloud Run and restricted to a configured Google domain.
Exposes 25 tools across Files, Paper Documents, Sharing, and Account categories so
Claude can read, write, search, and manage Dropbox on behalf of authenticated users.

### Added

**Files & Folders (14 tools)**
- `list_folder` — list folder contents with pagination cursor support
- `get_metadata` — get file or folder metadata (type, size, modified date, ID, Paper export info)
- `search_files` — search by keyword with filters for extension and file category
- `download_file` — read text file content (plain text, Markdown, JSON, code, etc.)
- `get_temporary_link` — get ~4-hour download URL for binary files (images, PDFs, etc.)
- `upload_file` — create or overwrite a file with text content; supports add, overwrite, and update modes
- `create_folder` — create a new folder
- `move_file` — move or rename a file or folder
- `copy_file` — copy a file or folder to a new path
- `delete_file` — soft delete (moves to Dropbox trash; recoverable for 180 days)
- `permanently_delete_file` — irreversible delete with no recovery path
- `list_revisions` — list file revision history with rev IDs
- `restore_revision` — roll a file back to a specific revision
- `export_file` — export Paper docs or Office files as Markdown or HTML

**Paper Documents (3 tools)**
- `list_paper_docs` — find all Paper docs in Dropbox, optionally filtered by keyword or folder
- `create_paper_doc` — create a new Paper document from Markdown, HTML, or plain text
- `update_paper_doc` — update an existing Paper doc (append, prepend, or full overwrite)

**Sharing (6 tools)**
- `create_shared_link` — create public, team-only, or password-protected shared links with optional expiry
- `list_shared_links` — list all shared links for a file or folder
- `revoke_shared_link` — delete a shared link by URL
- `add_file_member` — share a file with users by email (viewer or editor access)
- `list_file_members` — see who has access to a file
- `remove_file_member` — revoke a specific user's access to a file

**Account (2 tools)**
- `get_account_info` — account name, email, team, account type, and storage summary
- `get_space_usage` — detailed storage breakdown (individual quota or team allocation)

**Architecture**
- Express HTTP server deployed to Cloud Run
- Google OAuth gate — access restricted to a configured email domain
- Dropbox Business API with team-scoped OAuth2 refresh token; access tokens auto-refreshed before expiry
- `Dropbox-API-Select-User` header on all calls for Business team token compatibility
- Structured JSON logging to Cloud Logging with per-request audit trail (authenticated user, tool invoked, call duration)
- Per-user rate limiting: 60 requests/minute
- Retry with exponential backoff on Dropbox 429 and 5xx responses
- Health check at `/health` validates Dropbox credentials on startup
- Non-root Docker user for container security hardening
