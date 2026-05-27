# Security Policy

## Authentication & Authorization

- All `/mcp` requests require a valid Google OAuth 2.0 ID token (`Authorization: Bearer <token>`)
- Tokens are validated via Google's tokeninfo endpoint — invalid or expired tokens are rejected with HTTP 401
- Access is restricted to `@example.com` accounts only — non-Example Corp tokens return HTTP 403
- Per-user rate limiting: 60 requests/min; exceeding this returns HTTP 429

## Secrets Management

All credentials are stored in GCP Secret Manager (`your-gcp-project` project). No secrets are hardcoded or committed to git:
- `dropbox-app-key` — Dropbox OAuth2 app key
- `dropbox-app-secret` — Dropbox OAuth2 app secret
- `dropbox-refresh-token` — Dropbox OAuth2 refresh token (offline access)
- `dropbox-select-user` — Dropbox team member ID for Business API access
- `google-client-id-dropbox` — Google OAuth client ID
- `google-client-secret-dropbox` — Google OAuth client secret

## Infrastructure Security

- Cloud Run service runs as non-root user (`app`)
- Security headers on all responses: `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Cache-Control: no-store`
- HTTPS enforced via Cloud Run (TLS termination at load balancer)
- Container images scanned via `npm audit --audit-level=high` in Cloud Build before each deploy

## Audit Logging

All requests are logged to Cloud Logging with: authenticated user email, tool called, duration, and response status. Logs are retained per GCP project policy.

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability** to open a private advisory.

This keeps the report confidential until a fix is released. Please don't open a public issue for security vulnerabilities.

