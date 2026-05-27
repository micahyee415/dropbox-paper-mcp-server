# dropbox-paper-mcp

> A Model Context Protocol (MCP) server for Dropbox files and Paper documents (read + write), deployed on Google Cloud Run.

## Overview

`dropbox-paper-mcp` exposes 25 Dropbox tools to any MCP-compatible client (e.g. Claude.ai). It covers the full Dropbox surface — file and folder management, Dropbox Paper documents, sharing, and account info — with both read and write access.

Access is gated by Google OAuth: only accounts belonging to a configured email domain can authenticate. Each authenticated user operates under their own Dropbox identity via per-user impersonation, so users see only their own files with their own permissions.

**Key features:**

- 25 MCP tools across Files, Paper, Sharing, and Account categories
- Google OAuth domain gate — restrict access to `@your-domain.com` accounts only
- Per-user Dropbox impersonation via `Dropbox-API-Select-User` header
- In-memory team member cache (email → Dropbox `team_member_id`, refreshed hourly)
- Dropbox OAuth2 refresh-token flow with automatic access-token renewal
- Per-user rate limiting (60 req/min), exponential backoff on Dropbox 429/5xx
- Structured JSON logging with per-request audit trail (user, tool, duration, status)
- Deployed as a stateless StreamableHTTP MCP server on Google Cloud Run

---

## MCP Tools

### Files (14 tools)

| Tool | Description |
|------|-------------|
| `list_folder` | List folder contents with pagination cursor support |
| `get_metadata` | Get file or folder metadata (type, size, modified date, ID, Paper export info) |
| `search_files` | Search by keyword with filters for extension and file category |
| `download_file` | Read text file content (plain text, Markdown, JSON, code, etc.) |
| `get_temporary_link` | Get a ~4-hour direct download URL for binary files (images, PDFs, etc.) |
| `upload_file` | Create or overwrite a file with text content; supports add, overwrite, and update modes |
| `create_folder` | Create a new folder |
| `move_file` | Move or rename a file or folder |
| `copy_file` | Copy a file or folder to a new path |
| `delete_file` | Soft delete — moves to Dropbox trash (recoverable for 180 days) |
| `permanently_delete_file` | Irreversible delete with no recovery path |
| `list_revisions` | List file revision history with rev IDs |
| `restore_revision` | Roll a file back to a specific revision |
| `export_file` | Export a Paper doc or Office file as Markdown or HTML |

### Paper Documents (3 tools)

| Tool | Description |
|------|-------------|
| `list_paper_docs` | Find all Paper docs in Dropbox, optionally filtered by keyword or folder |
| `create_paper_doc` | Create a new Paper document from Markdown, HTML, or plain text |
| `update_paper_doc` | Update an existing Paper doc — append, prepend, or full overwrite |

### Sharing (6 tools)

| Tool | Description |
|------|-------------|
| `create_shared_link` | Create public, team-only, or password-protected shared links with optional expiry |
| `list_shared_links` | List all shared links for a file or folder |
| `revoke_shared_link` | Delete a shared link by URL |
| `add_file_member` | Share a file with users by email (viewer or editor access) |
| `list_file_members` | See who has access to a file |
| `remove_file_member` | Revoke a specific user's access to a file |

### Account (2 tools)

| Tool | Description |
|------|-------------|
| `get_account_info` | Account name, email, team, account type, and storage summary |
| `get_space_usage` | Detailed storage breakdown (individual quota or team allocation) |

---

## Architecture

```
MCP Client (e.g. Claude.ai)
    │
    │  HTTPS — Bearer: Google OAuth token
    ▼
Cloud Run: dropbox-mcp-server (Express, port 8080)
    │
    ├── auth.ts          Google tokeninfo validation → email domain check
    ├── team-cache.ts    In-memory email → Dropbox team_member_id (refreshed hourly)
    ├── rate-limiter.ts  60 req/min per user (fixed window, in-memory)
    │
    ├── dropbox-client.ts
    │     DropboxTokenManager  Refresh token → short-lived access token (4h TTL, auto-renewed)
    │     DropboxClient        Per-request client with Dropbox-API-Select-User header
    │
    └── tools/
          files.ts, paper.ts, sharing.ts, account.ts
                │
                ▼
        api.dropboxapi.com/2/        (metadata and control operations)
        content.dropboxapi.com/2/    (file upload and download)
```

**Transport:** StreamableHTTP (`/mcp` endpoint), stateless per request — a new `McpServer` and transport are created for each incoming request.

**Google OAuth flow:**

Every `/mcp` request must carry a Google OAuth bearer token. The server validates it via `https://oauth2.googleapis.com/tokeninfo`, checks the email domain against `ALLOWED_DOMAIN`, and verifies the audience claim against `GOOGLE_CLIENT_ID`. Tokens are cached in-memory (SHA-256 keyed, 60-second TTL, 500-entry cap) to reduce calls to Google.

**Dropbox OAuth refresh-token flow:**

A long-lived offline refresh token is stored in GCP Secret Manager. The `DropboxTokenManager` singleton exchanges it for a short-lived access token (4-hour TTL) on first use and automatically refreshes it 5 minutes before expiry, so no request ever fails due to a stale token.

**Per-user impersonation:**

At startup, `TeamMemberCache` calls `/team/members/list_v2` and builds an in-memory map of `email → team_member_id`. On each request, the authenticated user's email is looked up in this cache and the resulting `dbmid` is set as the `Dropbox-API-Select-User` header on all Dropbox API calls. Users without a Dropbox seat receive HTTP 403.

**Deploy:**

The server is built and deployed via Google Cloud Build (`cloudbuild.yaml`). The pipeline runs `npm audit --audit-level=high`, builds a Docker image, pushes it to Artifact Registry, and deploys to Cloud Run. Secrets are injected from GCP Secret Manager via `--set-secrets`.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22, TypeScript 5 |
| MCP SDK | `@modelcontextprotocol/sdk` v1.29+ |
| HTTP server | Express 5 |
| Validation | Zod 4 |
| Auth | Google OAuth 2.0 (tokeninfo endpoint) |
| Dropbox API | Dropbox API v2 (REST) |
| Deployment | Google Cloud Run (us-central1) |
| Secrets | GCP Secret Manager |
| Container | Docker (node:22-slim, non-root user) |
| Build | Google Cloud Build |
| Logging | Structured JSON → Google Cloud Logging |

---

## Getting Started

### Prerequisites

- Node.js 22+
- A [Dropbox app](https://www.dropbox.com/developers/apps) with a Business team token and an offline (refresh) token
  - Required scopes: `files.content.read`, `files.content.write`, `files.metadata.read`, `files.metadata.write`, `sharing.read`, `sharing.write`, `account_info.read`, `team_data.member`
- A Google Cloud project with a configured OAuth 2.0 client (for the domain gate)
- GCP project with Cloud Run and Artifact Registry enabled (for deployment)

### Install

```bash
git clone https://github.com/micahyee415/dropbox-paper-mcp-server
cd dropbox-paper-mcp-server
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `DROPBOX_APP_KEY` | Dropbox OAuth2 app key (client ID) |
| `DROPBOX_APP_SECRET` | Dropbox OAuth2 app secret |
| `DROPBOX_REFRESH_TOKEN` | Offline refresh token for the Dropbox Business API |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `ALLOWED_DOMAIN` | Email domain to allow (e.g. `example.com`) — only `@example.com` accounts can authenticate |
| `PORT` | HTTP port (default: `8080`) |
| `SERVER_URL` | Public URL of the deployed service (e.g. `https://your-service.example.com`) |

### Run locally

```bash
npm run build
npm start
```

The server starts on `http://localhost:8080`. The `/health` endpoint does not require authentication:

```bash
curl http://localhost:8080/health
```

### Deploy to Cloud Run

```bash
gcloud builds submit \
  --config cloudbuild.yaml \
  --project your-gcp-project \
  --substitutions COMMIT_SHA=$(git rev-parse HEAD) \
  .
```

The Cloud Build pipeline handles npm audit, Docker build, push to Artifact Registry, and Cloud Run deployment. Secrets are read from GCP Secret Manager — set them up before the first deploy:

```bash
for secret in dropbox-app-key dropbox-app-secret dropbox-refresh-token \
              google-client-id-dropbox google-client-secret-dropbox; do
  echo -n "VALUE" | gcloud secrets create $secret --data-file=- --project your-gcp-project
done
```

---

## Connecting an MCP Client

Once deployed, point your MCP client at the `/mcp` endpoint:

```
https://your-service.example.com/mcp
```

The server implements RFC 8414 (OAuth Authorization Server Metadata) and RFC 7591 (Dynamic Client Registration), so clients like Claude.ai can discover and register automatically via:

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/register`

---

## Operations

See [RUNBOOK.md](./RUNBOOK.md) for:

- Health check interpretation
- Deployment and rollback procedures
- Failure scenarios and remediation (token refresh failure, empty team cache, user 403s, Dropbox 429/5xx)
- Secret rotation procedures
- Scaling guidance
- Log queries and monitoring setup
- Incident response playbook

---

## Security

See [SECURITY.md](./SECURITY.md) for the full security policy, including:

- Authentication and authorization controls
- Secrets management (GCP Secret Manager)
- Infrastructure hardening (non-root container, security headers, HTTPS-only)
- Audit logging
- Vulnerability reporting

---
