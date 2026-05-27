# Dropbox MCP Server — Operational Runbook

**Service:** dropbox-mcp-server  
**Owner:** your-org IT  
**GitHub:** your-org/dropbox-paper-mcp  
**Service URL:** https://your-service.example.com  
**GCP Project:** your-gcp-project  
**Region:** us-central1  
**Last updated:** 2026-04-10  

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Architecture](#2-architecture)
3. [Health Check](#3-health-check)
4. [Deployment](#4-deployment)
5. [Rollback](#5-rollback)
6. [Failure Scenarios](#6-failure-scenarios)
   - 6.1 Health check failing / 503
   - 6.2 Team cache empty (cached_members: 0)
   - 6.3 User gets 403 Forbidden
   - 6.4 Dropbox API errors (429, 5xx)
   - 6.5 Token refresh failure
   - 6.6 Google OAuth verification failure
   - 6.7 Container startup failure
7. [Secret Rotation](#7-secret-rotation)
8. [Scaling](#8-scaling)
9. [Logs and Monitoring](#9-logs-and-monitoring)
10. [Incident Response](#10-incident-response)
11. [Tool Reference](#11-tool-reference)

---

## 1. Service Overview

The Dropbox MCP Server is a TypeScript/Express HTTP server running on GCP Cloud Run. It exposes 25 Dropbox tools to Claude via the Model Context Protocol (MCP), scoped to @example.com users only.

**Key behaviors:**
- Every `/mcp` request requires a Google OAuth bearer token from a `@example.com` account.
- After Google auth, the server maps the user's email to their Dropbox `team_member_id` from the in-memory team cache.
- All Dropbox API calls use per-user impersonation via the `Dropbox-API-Select-User` header — users see only their own files with their own permissions.
- Non-Dropbox users (valid Google OAuth but no Dropbox seat) get a `403` with a clear message to contact IT.
- Rate limiting: 60 requests per user per minute per instance.

**Tools (25 total):**

| Category | Tools |
|----------|-------|
| Files (14) | list_folder, get_metadata, search_files, download_file, get_temporary_link, upload_file, create_folder, move_file, copy_file, delete_file, permanently_delete_file, list_revisions, restore_revision, export_file |
| Paper (3) | list_paper_docs, create_paper_doc, update_paper_doc |
| Sharing (6) | create_shared_link, list_shared_links, revoke_shared_link, add_file_member, list_file_members, remove_file_member |
| Account (2) | get_account_info, get_space_usage |

**Cloud Run config:**
- Min instances: 1 (always warm — avoids cold-start latency)
- Max instances: 5
- Memory: 512 MB
- CPU: 1 vCPU
- Timeout: 60 seconds
- Concurrency: 80 requests per instance

---

## 2. Architecture

```
Claude.ai
    │
    │  HTTPS (Bearer: Google OAuth token)
    ▼
Cloud Run: dropbox-mcp-server
    │
    ├── auth.ts          Google tokeninfo validation → email domain check (@example.com)
    ├── team-cache.ts    In-memory email → dbmid map (refreshes hourly)
    ├── rate-limiter.ts  60 req/min per user, per instance (fixed window)
    │
    ├── dropbox-client.ts
    │     DropboxTokenManager  Dropbox OAuth2 refresh token → short-lived access token (4h TTL)
    │     DropboxClient        Per-request client with Dropbox-API-Select-User header
    │
    └── tools/
          files.ts, paper.ts, sharing.ts, account.ts
                │
                ▼
        api.dropboxapi.com/2/        (metadata / control)
        content.dropboxapi.com/2/    (file upload / download)
```

**Secrets (GCP Secret Manager):**

| Secret name | Used for |
|-------------|----------|
| `dropbox-app-key` | Dropbox OAuth2 app key (client ID) |
| `dropbox-app-secret` | Dropbox OAuth2 app secret |
| `dropbox-refresh-token` | Long-lived offline refresh token for Dropbox Business API |
| `google-client-id-dropbox` | Google OAuth2 client ID (for RFC 7591 dynamic client registration) |
| `google-client-secret-dropbox` | Google OAuth2 client secret |

---

## 3. Health Check

The `/health` endpoint validates Dropbox credentials and reports team cache size. It does NOT require authentication.

```bash
curl https://your-service.example.com/health
```

**Healthy response (HTTP 200):**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "transport": "http",
  "dropbox_team": "Example Corp",
  "cached_members": 143
}
```

**Unhealthy response (HTTP 503):**
```json
{
  "status": "error",
  "reason": "Dropbox credentials invalid or API unreachable."
}
```

What the health check tests:
- Access token refresh (if expired)
- `/team/get_info` API call succeeds
- Team cache is populated (`cached_members` > 0)

The health check does NOT test:
- Google OAuth flow (requires a real user token)
- Per-user impersonation (requires a valid `dbmid`)

---

## 4. Deployment

### Prerequisites

- `gcloud` CLI authenticated to the `your-gcp-project` project
- Docker available locally (Cloud Build handles the actual build)
- You are on the `main` branch with a clean working tree

### Standard deploy (from a clean commit on main)

```bash
# From the repo root
cd /path/to/dropbox-paper-mcp

# Verify the current commit
git log --oneline -1

# Submit build and deploy via Cloud Build
gcloud builds submit \
  --config cloudbuild.yaml \
  --project your-gcp-project \
  --substitutions COMMIT_SHA=$(git rev-parse HEAD) \
  .
```

**What Cloud Build does (4 steps):**
1. `npm audit --audit-level=high` — fails the build if high/critical vulnerabilities exist
2. `docker build` — builds image tagged with `$COMMIT_SHA` and `latest`
3. `docker push --all-tags` — pushes both tags to Artifact Registry
4. `gcloud run deploy` — deploys the `$COMMIT_SHA`-tagged image to Cloud Run

**Image registry:**
```
us-central1-docker.pkg.dev/your-gcp-project/mcp-servers/dropbox-mcp-server
```

### Verify deployment

```bash
# Check Cloud Run service status
gcloud run services describe dropbox-mcp-server \
  --region us-central1 \
  --project your-gcp-project

# Run health check
curl https://your-service.example.com/health

# Tail live logs
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server"' \
  --project your-gcp-project \
  --order desc \
  --limit 50 \
  --format "table(timestamp, jsonPayload.severity, jsonPayload.message)"
```

### Build duration

Typical build + deploy time: 3–5 minutes.

---

## 5. Rollback

### Identify the previous revision

```bash
gcloud run revisions list \
  --service dropbox-mcp-server \
  --region us-central1 \
  --project your-gcp-project \
  --sort-by "~DEPLOYED" \
  --limit 5
```

This lists revisions newest first. Note the name of the last known-good revision (e.g. `dropbox-mcp-server-00042-abc`).

### Rollback to a previous revision

```bash
gcloud run services update-traffic dropbox-mcp-server \
  --region us-central1 \
  --project your-gcp-project \
  --to-revisions REVISION_NAME=100
```

Replace `REVISION_NAME` with the revision name from the list above.

### Verify rollback

```bash
curl https://your-service.example.com/health
```

Confirm `status: ok` and check the `cached_members` count is non-zero.

### Rollback via a new deploy (preferred for code fixes)

If the issue is in code, fix it in the repo, commit, and run the standard deploy command. This creates a new revision rather than reverting traffic — cleaner audit trail.

**When to use traffic rollback vs. new deploy:**
- Traffic rollback: fastest; use during active incidents when you need to restore service immediately.
- New deploy: use when you have a code fix ready and the incident is not actively impacting users.

---

## 6. Failure Scenarios

---

### 6.1 Health check failing / 503

**Symptom:** `/health` returns HTTP 503 or `status: error`.

**Diagnosis:**

```bash
# Check recent error logs
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server" AND jsonPayload.severity="ERROR"' \
  --project your-gcp-project \
  --order desc \
  --limit 20

# Check if the service is running at all
gcloud run services describe dropbox-mcp-server \
  --region us-central1 \
  --project your-gcp-project \
  --format "value(status.conditions)"
```

**Root causes and fixes:**

| Root cause | Log message | Fix |
|------------|-------------|-----|
| Dropbox refresh token expired or revoked | `Failed to refresh Dropbox token (400)` | Rotate `dropbox-refresh-token` — see Section 7 |
| Dropbox API unreachable | `Dropbox API error on /team/get_info (5xx)` | Transient; wait and retry. If persistent, check Dropbox status page |
| Secret not found in Secret Manager | `Missing required environment variable: DROPBOX_APP_KEY` | Verify secrets exist in Secret Manager and Cloud Run has access — see Section 7 |
| Container failed to start | No health check response at all | Check Cloud Run revision status and startup logs |

---

### 6.2 Team cache empty (cached_members: 0)

**Symptom:** `/health` returns `"cached_members": 0`. All authenticated users get `403 Forbidden`.

**What happened:** The team cache failed to load at startup, or a refresh attempt failed silently after startup.

**Diagnosis:**

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server"' \
  --project your-gcp-project \
  --order desc \
  --limit 30 \
  --format "table(timestamp, jsonPayload.severity, jsonPayload.message, jsonPayload.reason)"
```

Look for:
- `Team member cache refreshed` with `activeMembers: 0` — the API call succeeded but returned no active members (unusual; would indicate a Dropbox account problem)
- `Team member cache refresh failed` — the API call itself errored (likely token or network issue)
- `Loading Dropbox team member cache...` with no subsequent `Team member cache ready` — startup failed mid-load

**Root causes and fixes:**

| Root cause | Fix |
|------------|-----|
| Dropbox token invalid when cache was loaded | Rotate token (Section 7), then restart the service (see below) |
| `/team/members/list_v2` API rate limited at startup | Restart the service; rate limits are typically short-lived |
| Team has 0 active members (account issue) | Check Dropbox Business admin console |

**Restart the service (forces cache reload):**

```bash
# Deploy a new revision (no code changes needed — just re-deploys the current image)
gcloud run deploy dropbox-mcp-server \
  --image us-central1-docker.pkg.dev/your-gcp-project/mcp-servers/dropbox-mcp-server:latest \
  --region us-central1 \
  --project your-gcp-project
```

**Expected log sequence on healthy startup:**
```
Loading Dropbox team member cache...
Refreshing Dropbox access token
Dropbox access token refreshed { expiresInMin: 239 }
Team member cache refreshed { activeMembers: 143 }
Team member cache ready { members: 143 }
Dropbox MCP server ready { port: 8080, allowedDomain: "example.com" }
```

---

### 6.3 User gets 403 Forbidden

**Symptom:** A specific user gets `403` when trying to use the MCP tools. Other users are not affected.

**Possible causes:**

**A. User has a valid @example.com Google account but no Dropbox seat**

The error message will be: `<email> is not an active Dropbox team member. Contact IT to provision Dropbox access.`

Fix: Add the user to the Dropbox Business team in the Dropbox admin console. The team cache refreshes hourly, so the user will be able to connect within 60 minutes. If they need access immediately, restart the service to force a cache reload.

**B. User's Dropbox account was suspended**

The `TeamMemberCache` only caches members with `status.tag === "active"`. Suspended or removed members are excluded from the cache, so they get 403.

Fix: Reactivate the user's Dropbox account in the admin console. Cache will pick it up on the next hourly refresh.

**C. User's email does not end in @example.com**

The Google OAuth validation rejects any token whose email domain is not `example.com`. This is enforced before the Dropbox lookup. The user will see: `Access restricted to @example.com accounts.`

This is expected behavior — not a bug.

**D. Stale cache after a new hire or transfer**

If a user was added to Dropbox within the last hour, they won't be in the cache yet.

Fix: Wait up to 60 minutes, or restart the service to force an immediate cache reload.

**Checking cache state in logs:**

```bash
# Find auth failures for a specific user
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server" AND jsonPayload.event="auth_failure"' \
  --project your-gcp-project \
  --order desc \
  --limit 20 \
  --format "table(timestamp, jsonPayload.userEmail, jsonPayload.reason)"
```

---

### 6.4 Dropbox API errors (429, 5xx)

**Symptom:** Users see tool errors like `Dropbox API error on /files/list_folder (429)` or `(500)`.

**How retries work:** The `DropboxClient` automatically retries 429 and 5xx errors up to 3 attempts with exponential backoff (1s, 2s, 4s max 8s). If all retries fail, the error surfaces to the user.

**429 Rate limiting:**

Dropbox Business API rate limits are per app, across all users. If you see frequent 429s in logs:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server" AND jsonPayload.message="Dropbox API error, retrying"' \
  --project your-gcp-project \
  --order desc \
  --limit 20 \
  --format "table(timestamp, jsonPayload.userEmail, jsonPayload.reason)"
```

If you see heavy 429 activity from a single user, check their session in Claude — they may be running an unusual bulk operation. The per-user rate limiter (60 req/min) prevents one user from overwhelming the service, but it doesn't prevent them from hitting Dropbox's own API limits.

**5xx errors:**

These indicate Dropbox API instability. Check the Dropbox status page at https://status.dropbox.com. If Dropbox is reporting an incident, wait for resolution — there is nothing to fix on the server side.

---

### 6.5 Token refresh failure

**Symptom:** Health check returns 503. Logs show `Failed to refresh Dropbox token (400)`. All user requests fail because no valid access token can be obtained.

**What happened:** The `dropbox-refresh-token` secret in GCP Secret Manager either:
- Was revoked (someone disconnected the app in Dropbox admin)
- Expired (Dropbox offline tokens do not expire but can be revoked)
- The `dropbox-app-key` or `dropbox-app-secret` changed

**Immediate triage:**

```bash
# Verify the secrets are present and not empty
gcloud secrets versions access latest \
  --secret dropbox-refresh-token \
  --project your-gcp-project | wc -c

gcloud secrets versions access latest \
  --secret dropbox-app-key \
  --project your-gcp-project | head -c 20
```

If the values look correct, the token was likely revoked externally. Proceed to Section 7 (Secret Rotation) to generate a new refresh token.

---

### 6.6 Google OAuth verification failure

**Symptom:** Users get `401 Invalid or expired Google OAuth token` or `503 Google OAuth verification timed out`.

**Root cause A — Token expired:** Google access tokens expire after 1 hour. Claude.ai handles re-authentication automatically. If a user sees this, they should disconnect and reconnect the MCP server in Claude.ai.

**Root cause B — Google tokeninfo endpoint unreachable:** The server calls `https://oauth2.googleapis.com/tokeninfo` with a 5-second timeout on every request (unless cached). If Google's token verification is down or slow:

```bash
# Check for auth timeout errors
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server" AND jsonPayload.reason=~"timed out"' \
  --project your-gcp-project \
  --order desc \
  --limit 10
```

The token cache (in-memory, 60-second TTL, max 500 entries) reduces calls to Google for active users. During a Google outage, users with cached tokens (within 60 seconds of their last request) will continue to work. New sessions or expired cache entries will fail with 503.

There is no fix other than waiting for Google's services to recover.

**Root cause C — GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET misconfigured:** These are used only for the dynamic client registration endpoint (`/register`), not for token verification. If `/register` fails, that secret may be missing, but it does not affect the `/mcp` endpoint.

---

### 6.7 Container startup failure

**Symptom:** Cloud Run shows revision as failed. Health check is unreachable. Logs show `Failed to start server`.

**Diagnosis:**

```bash
gcloud run revisions describe REVISION_NAME \
  --region us-central1 \
  --project your-gcp-project

gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server"' \
  --project your-gcp-project \
  --order desc \
  --limit 20 \
  --format "table(timestamp, jsonPayload.severity, jsonPayload.message, jsonPayload.reason)"
```

**Common startup failure causes:**

| Cause | Log message | Fix |
|-------|-------------|-----|
| Missing environment variable | `Missing required environment variable: DROPBOX_APP_KEY` | Check that all 5 secrets are correctly specified in the Cloud Run `--set-secrets` config |
| Team cache init failed (token invalid) | `Failed to start server` + token error | Rotate Dropbox refresh token (Section 7) |
| Port conflict or crash in startup | Node.js crash stack trace | Check the code change that introduced the regression; rollback (Section 5) |

The server does not start accepting traffic until the team cache is fully loaded. If the cache init fails, the entire process exits. This is intentional — a server with an empty cache would reject all users.

---

## 7. Secret Rotation

All secrets are stored in GCP Secret Manager under the `your-gcp-project` project. The Cloud Run service mounts them as environment variables at startup via `--set-secrets`.

### View current secret versions

```bash
# List all relevant secrets
for secret in dropbox-app-key dropbox-app-secret dropbox-refresh-token google-client-id-dropbox google-client-secret-dropbox; do
  echo "=== $secret ==="
  gcloud secrets versions list $secret --project your-gcp-project --limit 3
done
```

### Rotate dropbox-refresh-token

This is the most likely rotation scenario — the refresh token can be revoked if someone disconnects the app in the Dropbox admin console.

**Step 1: Generate a new refresh token**

The refresh token is obtained through the Dropbox OAuth2 authorization flow. You need:
- The app key and secret from `dropbox-app-key` and `dropbox-app-secret`
- A Dropbox Business admin account

Follow the Dropbox OAuth2 offline access flow (PKCE or authorization code) using the Dropbox developer console or the `dropbox-auth` CLI tool. The resulting offline token is the new refresh token.

**Step 2: Store the new token in Secret Manager**

```bash
# Create a new version (do NOT delete the old version yet — keep it for rollback)
echo -n "NEW_REFRESH_TOKEN_VALUE" | gcloud secrets versions add dropbox-refresh-token \
  --data-file=- \
  --project your-gcp-project
```

**Important:** Paste the token value without a trailing newline. The `echo -n` flag ensures this.

**Step 3: Redeploy to pick up the new secret**

```bash
gcloud run deploy dropbox-mcp-server \
  --image us-central1-docker.pkg.dev/your-gcp-project/mcp-servers/dropbox-mcp-server:latest \
  --region us-central1 \
  --project your-gcp-project
```

Cloud Run always pulls `latest` version of each secret on each revision creation — no `--set-secrets` changes are needed.

**Step 4: Verify**

```bash
curl https://your-service.example.com/health
```

Confirm `status: ok` and `dropbox_team: Example Corp`.

**Step 5: Disable the old secret version**

Once the new revision is stable (at least 30 minutes of clean health checks), disable the old version:

```bash
# List versions to find the old one
gcloud secrets versions list dropbox-refresh-token --project your-gcp-project

# Disable the old version (not destroy — keep for audit trail)
gcloud secrets versions disable OLD_VERSION_NUMBER \
  --secret dropbox-refresh-token \
  --project your-gcp-project
```

### Rotate Google OAuth credentials (google-client-id-dropbox, google-client-secret-dropbox)

These are used for the `/register` endpoint (RFC 7591 dynamic client registration) that Claude.ai calls when first connecting.

If these need rotation:
1. Create a new OAuth 2.0 client ID in the [Google Cloud Console](https://console.cloud.google.com) for the `your-gcp-project` project.
2. Add the new `client_id` and `client_secret` as new versions of the respective secrets in Secret Manager.
3. Redeploy the Cloud Run service.
4. Reconnect the Dropbox MCP server in Claude.ai (it will re-register with the new credentials).

### Rotate Dropbox app key/secret

Only needed if the Dropbox app itself is compromised or re-created in the Dropbox developer console.

1. Get the new key and secret from the Dropbox App Console.
2. Add new versions to `dropbox-app-key` and `dropbox-app-secret`.
3. Generate a new refresh token (the old one is tied to the old app).
4. Add the new refresh token to `dropbox-refresh-token`.
5. Redeploy.

---

## 8. Scaling

### Current configuration

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Min instances | 1 | Always-warm; avoids cold start for users |
| Max instances | 5 | Sufficient for small-to-mid-size teams |
| Concurrency | 80 | MCP requests are async I/O bound; high concurrency is safe |
| Memory | 512 MB | Team cache + Express overhead; well within limits |
| CPU | 1 vCPU | Adequate for current load |

### Rate limiter caveat

The in-memory rate limiter is per-instance. If Cloud Run scales to 2 instances, each user effectively gets 120 requests/min instead of 60. With min-instances=1, a single instance handles all traffic under normal load for small-to-mid-size teams. If you ever raise max-instances above 1 and need strict per-user rate limiting, move the limiter to Firestore or Redis.

### Scaling triggers

Cloud Run scales on concurrent request count. With concurrency=80 and min=1:
- Instance 2 spins up when the first instance reaches ~80 concurrent requests
- With typical team sizes, this only happens if many users are hitting the service simultaneously

### Memory pressure

The team cache holds email + dbmid string pairs for active team members — negligible memory at typical team sizes. The Google token cache holds up to 500 entries. If you see OOM errors as your team grows, raise memory to 1 GB:

```bash
gcloud run services update dropbox-mcp-server \
  --region us-central1 \
  --project your-gcp-project \
  --memory 1Gi
```

### CPU pressure

The service is almost entirely I/O bound (Dropbox API calls, Google tokeninfo calls). CPU pressure is extremely unlikely. If you see high latency under load, the bottleneck is almost certainly Dropbox API response times, not CPU.

---

## 9. Logs and Monitoring

### Log format

All logs are structured JSON written to stderr. Cloud Logging indexes the fields automatically.

Key fields:
- `severity` — DEBUG / INFO / WARNING / ERROR
- `message` — human-readable description
- `userEmail` — who made the request (SOC 2 audit trail)
- `tool` — which MCP tool was called
- `durationMs` — request duration
- `event` — login, auth_failure, rate_limited, usage
- `reason` — error detail when relevant

### Common log queries (Cloud Logging)

**All errors:**
```
resource.type="cloud_run_revision"
resource.labels.service_name="dropbox-mcp-server"
jsonPayload.severity="ERROR"
```

**Auth failures:**
```
resource.type="cloud_run_revision"
resource.labels.service_name="dropbox-mcp-server"
jsonPayload.event="auth_failure"
```

**Usage by user:**
```
resource.type="cloud_run_revision"
resource.labels.service_name="dropbox-mcp-server"
jsonPayload.event="usage"
```

**Rate limit hits:**
```
resource.type="cloud_run_revision"
resource.labels.service_name="dropbox-mcp-server"
jsonPayload.event="rate_limited"
```

**Token refreshes:**
```
resource.type="cloud_run_revision"
resource.labels.service_name="dropbox-mcp-server"
jsonPayload.message="Dropbox access token refreshed"
```

### CLI log access

```bash
# Stream live logs
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server"' \
  --project your-gcp-project \
  --order desc \
  --limit 50 \
  --format "table(timestamp, jsonPayload.severity, jsonPayload.userEmail, jsonPayload.message)"
```

### Monitoring alerts (recommended, not yet configured)

Set up Cloud Monitoring alerts for:
- Health check endpoint returning non-200 for > 2 minutes
- Error rate > 5% over a 5-minute window
- `dropbox-refresh-token` secret version approaching 90 days old (proactive rotation reminder)

---

## 10. Incident Response

### Severity classification

| Severity | Condition | Target resolution |
|----------|-----------|-------------------|
| P1 | Service completely down — all users affected | 30 minutes |
| P2 | Subset of users affected (e.g., specific users getting 403) | 2 hours |
| P3 | Degraded performance or non-critical tool failures | Next business day |

### P1 Response — Service completely down

1. **Confirm the outage:**
   ```bash
   curl https://your-service.example.com/health
   ```

2. **Check Cloud Run service status:**
   ```bash
   gcloud run services describe dropbox-mcp-server \
     --region us-central1 --project your-gcp-project
   ```

3. **Check recent logs for root cause:**
   ```bash
   gcloud logging read \
     'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server" AND jsonPayload.severity="ERROR"' \
     --project your-gcp-project --order desc --limit 20
   ```

4. **If a bad deployment caused the outage → rollback (Section 5).**

5. **If Dropbox token expired → rotate token (Section 7).**

6. **If Dropbox API is down → check https://status.dropbox.com. No action needed — wait for Dropbox recovery.**

7. **If root cause unclear → rollback to previous known-good revision immediately, then investigate.**

8. **Communicate:** Notify affected users and relevant stakeholders through your team's standard incident communication channel.

9. **Post-incident:** After resolution, document in the incident log and update this runbook if a new failure mode was discovered.

### P2 Response — Individual user 403

1. Confirm the user has a `@example.com` Google account.
2. Check if the user has a Dropbox seat in the Dropbox Business admin console.
3. If they have a seat and it's active:
   - Check if the hourly cache refresh has run since they were added (see `Team member cache refreshed` log entries).
   - If not, restart the service to force a cache reload.
4. If they don't have a seat: provision one, then wait for the next cache refresh (up to 60 min) or restart the service.

### P3 Response — Specific tool failing

1. Reproduce the failure by checking what tool is failing and what error the user is seeing.
2. Check logs for the specific endpoint:
   ```bash
   gcloud logging read \
     'resource.type="cloud_run_revision" AND resource.labels.service_name="dropbox-mcp-server" AND jsonPayload.event="usage"' \
     --project your-gcp-project --order desc --limit 20
   ```
3. If it's a Dropbox API error (409 for wrong content type, 400 for bad path, etc.), it is likely a user error, not a service error. The tool will return a descriptive error message to the user.
4. If it's a consistent 5xx from Dropbox for all users, check Dropbox status page.

---

## 11. Tool Reference

### Files (14 tools)

| Tool | Description | Key parameters |
|------|-------------|----------------|
| `list_folder` | List folder contents with pagination | `path`, `recursive`, `limit`, `cursor` |
| `get_metadata` | Get file or folder metadata | `path` |
| `search_files` | Search by name or content keyword | `query`, `path`, `max_results`, `file_extensions`, `file_categories` |
| `download_file` | Download text file content | `path` |
| `get_temporary_link` | Get ~4h download URL for binary files | `path` |
| `upload_file` | Create or overwrite a file | `path`, `content`, `mode` (add/overwrite/update) |
| `create_folder` | Create a new folder | `path`, `autorename` |
| `move_file` | Move or rename a file/folder | `from_path`, `to_path` |
| `copy_file` | Copy a file or folder | `from_path`, `to_path` |
| `delete_file` | Soft delete (recoverable, 180 days) | `path` |
| `permanently_delete_file` | Hard delete (no recovery) | `path` |
| `list_revisions` | List file revision history | `path`, `limit` |
| `restore_revision` | Restore file to a specific revision | `path`, `rev` |
| `export_file` | Export Paper doc as markdown or HTML | `path`, `export_format` |

### Paper (3 tools)

| Tool | Description | Key parameters |
|------|-------------|----------------|
| `list_paper_docs` | Find all Paper docs | `query`, `folder`, `max_results` |
| `create_paper_doc` | Create a new Paper doc | `path`, `content`, `import_format` |
| `update_paper_doc` | Update existing Paper doc | `path`, `content`, `doc_update_policy` (overwrite_all/append/prepend/update) |

### Sharing (6 tools)

| Tool | Description | Key parameters |
|------|-------------|----------------|
| `create_shared_link` | Create public or team-only link | `path`, `access`, `allow_download`, `expires` |
| `list_shared_links` | List shared links for a file | `path`, `direct_only` |
| `revoke_shared_link` | Delete a shared link | `url` |
| `add_file_member` | Share file with users by email | `path`, `emails`, `access_level` |
| `list_file_members` | List who has access to a file | `path`, `limit` |
| `remove_file_member` | Revoke a user's file access | `path`, `email` |

### Account (2 tools)

| Tool | Description |
|------|-------------|
| `get_account_info` | Account name, email, team, storage summary |
| `get_space_usage` | Detailed storage quota (individual or team breakdown) |

### Common error messages and their meaning

| Error message | Cause | User action |
|---------------|-------|-------------|
| `Missing Authorization header` | No Google OAuth token sent | Reconnect in Claude.ai |
| `Invalid or expired Google OAuth token` | Token expired or invalid | Disconnect and reconnect in Claude.ai |
| `Access restricted to @example.com accounts` | Non-example.com Google account | Use your @example.com account |
| `<email> is not an active Dropbox team member` | No Dropbox seat | Contact IT to provision Dropbox |
| `Rate limit exceeded. Try again in Xs` | 60 req/min per user exceeded | Wait and retry |
| `Cannot download this file type as text` | Tried to download a Paper doc with download_file | Use `export_file` instead |
| `A shared link already exists for this path` | Duplicate shared link creation | Use `list_shared_links` to retrieve the existing link |
| `Dropbox credentials invalid or API unreachable` | Health check failed | IT: check token and Dropbox API status |
