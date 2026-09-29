# Render Environment

The production frontend and backend are separate services:

- Frontend static site: `https://siconstableexam-1.onrender.com`
- Backend web service: `https://siconstableexam.onrender.com`
- Source repository/branch: `Srikanth15-06/SiConstableExam`, `main`

## Frontend Static Site

Configure the Render static site with:

```text
Root Directory: frontend/
Build Command: npm install; npm run build
Publish Directory: dist
```

Add a **Rewrite** rule (not Redirect):

```text
Source:      /api/*
Destination: https://siconstableexam.onrender.com/api/*
```

Leave `VITE_API_BASE_URL` unset so browser requests use the same-origin rewrite. Do not add backend secrets to this service. `VITE_API_PROXY_TARGET` is only for local Vite development.

## Backend Web Service

Use the repository root and the existing Node service commands:

```text
Root Directory: (blank / repository root)
Build Command: npm install && npm --prefix frontend install && npm run build
Start Command: node server/index.mjs
```

Render provides `PORT`; the server listens on that value. Configure these variables on the backend service only:

| Variable | Required value |
| --- | --- |
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | Long random signing key; required in production |
| `FRONTEND_URL` | `https://siconstableexam-1.onrender.com` |
| `FRONTEND_ORIGINS` | Optional comma-separated additional allowed origins; do not use `*` |
| `GOOGLE_DRIVE_ADMIN_KEY` | Separate long random administrator key; entered at runtime in the Notes Library UI |
| `GOOGLE_CLIENT_ID` | OAuth Web application client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth Web application client secret |
| `GOOGLE_REDIRECT_URI` | `https://siconstableexam-1.onrender.com/api/drive/oauth2callback` |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | ID of the Notes Library root folder |
| `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` | 32-byte base64 key or 64-character hex key |
| `DATABASE_URL` | PostgreSQL connection URL for durable OAuth token storage |
| `DATABASE_SSL` | Optional `true` if the database provider requires TLS |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Defaults to `true`; set `false` only if the provider documents an unverifiable certificate chain |
| `GOOGLE_DRIVE_SHARED_DRIVE_ID` | Optional; not required for My Drive |
| `GOOGLE_DRIVE_TOKEN_FILE` | Optional encrypted token file path on a persistent mount |
| `GOOGLE_DRIVE_TOKEN_FILE_DURABLE` | Set `true` only for a custom path known to be persistent |
| `GOOGLE_DRIVE_TOKEN_VAULT_SERVICE_ACCOUNT_JSON` | Optional service-account JSON used only for the encrypted token vault in the existing Drive root |

Keep existing AI provider variables (`GEMINI_API_KEY_n` / `GEMINI_MODEL_n`, `GROQ_API_KEY_n` / `GROQ_MODEL_n`, and `OPENROUTER_API_KEY_n` / `OPENROUTER_MODEL_n`) unchanged. Render's `PORT` is managed by the platform; do not set `VITE_*` secrets.

## Durable Storage

The backend supports PostgreSQL and encrypts the OAuth token payload before writing it to `google_drive_oauth_tokens`. Configure a PostgreSQL service/provider and set `DATABASE_URL` to its private connection URL. PostgreSQL TLS certificate validation stays enabled by default. Alternatively, attach a persistent disk mounted at `/var/data` and set `GOOGLE_DRIVE_TOKEN_FILE=/var/data/google-drive-token.enc`; Render Free does not support persistent disks. On Render Free, set `GOOGLE_DRIVE_TOKEN_VAULT_SERVICE_ACCOUNT_JSON` to use an existing service account only for the reserved encrypted token file. The OAuth callback creates the file and grants that account file-level access; do not grant it access to the root folder. OAuth remains the Notes Library identity. The production service refuses to call its default ephemeral `.data/` directory durable.

After configuring storage, set the stable encryption key, redeploy, unlock Drive management with `GOOGLE_DRIVE_ADMIN_KEY`, and connect the Google account once. Verify `GET /api/health`, `/api/drive/status`, and `/api/drive/test` through the frontend host.