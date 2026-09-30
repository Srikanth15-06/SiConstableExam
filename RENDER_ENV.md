# Render Environment

Production uses separate Render Free services:

- Frontend: `https://siconstableexam-1.onrender.com`
- Backend: `https://siconstableexam.onrender.com`
- Repository/branch: `Srikanth15-06/SiConstableExam`, `main`

## Frontend Static Site

```text
Root Directory: frontend/
Build Command: npm install; npm run build
Publish Directory: dist
```

Add a **Rewrite** rule from `/api/*` to `https://siconstableexam.onrender.com/api/*`. Leave `VITE_API_BASE_URL` unset for this same-origin rewrite. Keep backend secrets out of the static service; `VITE_API_PROXY_TARGET` is only for local development.

## Backend Web Service

```text
Root Directory: (repository root)
Build Command: npm ci && npm --prefix frontend install && npm run build
Start Command: node server/index.mjs
```

Render provides `PORT`. Configure these variables on the backend only:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Set to `production` |
| `FRONTEND_URL` | `https://siconstableexam-1.onrender.com` |
| `SESSION_SECRET` | Long random server session/OAuth signing secret |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend-only privileged key; never expose to Vite/browser |
| `SUPABASE_ANON_KEY` | Optional project key; the browser does not use Supabase directly |
| `FRONTEND_ORIGINS` | Optional additional exact origins; never use `*` |
| `GEMINI_API_KEY_n` / `GEMINI_MODEL_n` | Optional AI provider configuration |
| `GROQ_API_KEY_n` / `GROQ_MODEL_n` | Optional AI provider configuration |
| `OPENROUTER_API_KEY_n` / `OPENROUTER_MODEL_n` | Optional AI provider configuration |

Google Drive Notes is optional. If enabled, keep these backend-only variables:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Existing OAuth client |
| `GOOGLE_CLIENT_SECRET` | Existing OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `https://siconstableexam-1.onrender.com/api/drive/oauth2callback` |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | Existing root `1rz_XI2AkAkQNfrsbKW9Rs78xSptWFJ1z` |
| `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` | Encrypts the OAuth token stored in Supabase |
| `GOOGLE_DRIVE_ADMIN_KEY` | Authorizes Notes Library management |
| `GOOGLE_DRIVE_SHARED_DRIVE_ID` | Optional; not needed for the existing My Drive folder |

Do not configure `DATABASE_URL`, PostgreSQL services, Render disks, `GOOGLE_DRIVE_TOKEN_FILE`, or `GOOGLE_DRIVE_TOKEN_VAULT_SERVICE_ACCOUNT_JSON`. Do not put `SUPABASE_SERVICE_ROLE_KEY`, OAuth secrets, AI keys, or session secrets in any `VITE_*` variable.

## Supabase and Readiness

Apply the SQL migration under `supabase/migrations/` to the selected Supabase project before deploying. Supabase is the durable store for accounts, password hashes, hashed sessions, progress, quiz attempts/results, planner state, and user history. RLS is enabled with no browser-role table access; only the backend service-role client uses the database. The Google Drive Notes Library stays in the existing Google account/root; only its encrypted OAuth token is stored in Supabase. No Render filesystem persistence is used.

`GET /api/health` reports only `{database: {provider, configured, reachable}}` and readiness booleans; it never returns keys or connection details. A ready deployment requires the Supabase URL/service key and an applied migration. If Supabase is down or unconfigured, health returns a non-ready status without clearing user data.