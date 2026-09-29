# TS Police AI Prep

A browser-based study and exam-preparation app for Telangana Police SI and Constable candidates. It combines syllabus-based practice, AI-generated learning material, progress tracking, a study planner, and an optional Google Drive notes library.

## What the project contains

This repository has two separately installed parts:

- `frontend/` is the React 19 application built with Vite. It presents the study experience and calls the backend through `/api` requests.
- `server/` is a Node.js ES module application built on Express. It exposes the AI and Google Drive APIs and handles the Google OAuth callback.
- The root `package.json` provides commands to run, build, and test both parts. Install dependencies at the root and in `frontend/` because the frontend is not an npm workspace.

### Main features

- Select an exam, subject, topic, and difficulty from the built-in syllabus.
- Generate ten validated practice questions through Gemini, create study notes through Groq, and ask contextual study questions through OpenRouter.
- Take practice tests and review answers, explanations, shortcuts, scores, and test history.
- Track topic progress and use the study planner to prioritize revision.
- Connect Google Drive to browse topic folders, preview or download notes, provision subject/topic folders, and upload supported files (up to 20 MB).
- Keep separate local browser profiles for individual learners.

## Architecture and requests

During development, Vite normally runs at `http://localhost:5173`. Its `/api` proxy forwards requests to the Express server at `http://localhost:8787` (configurable with `VITE_API_PROXY_TARGET`). The browser-side API client can use `VITE_API_BASE_URL` when a different API base URL is needed.

The Express server provides these API groups:

- `/api/ai/*` for AI provider status, question generation, notes, and chat.
- `/api/drive/auth`, `/api/drive/oauth2callback`, `/api/drive/status`, and `/api/drive/test` for OAuth and diagnostics.
- `/api/drive/folders`, `/api/drive/upload`, `/api/drive/files`, and `/api/drive/files/:id` for root-scoped Notes Library operations.
- `/api/drive/admin/session` for administrator sign-in/out; mutating Drive operations require its HTTP-only session.
- `/api/health` for a basic server health check.

Locally, the Express server can serve the built frontend from `frontend/dist`. In production, Render serves `frontend/` as a static site and rewrites `/api/*` to the separate Express service. The API remains same-origin from the browser; if using a different host, configure `VITE_API_BASE_URL` explicitly and set the backend's allowed frontend origin.

## Render deployment

Production uses two Render services: a static frontend at `https://siconstableexam-1.onrender.com` and the Node API at `https://siconstableexam.onrender.com`.

```text
Frontend service:
  Root Directory: frontend/
  Build Command: npm install; npm run build
  Publish Directory: dist

Backend web service:
  Root Directory: repository root
  Build Command: npm install && npm --prefix frontend install && npm run build
  Start Command: node server/index.mjs
```

The static service needs a Render **Rewrite** rule from `/api/*` to `https://siconstableexam.onrender.com/api/*`. This keeps API and OAuth callback requests on the frontend origin. Leave `VITE_API_BASE_URL` unset; `VITE_API_PROXY_TARGET=http://localhost:8787` is for local Vite development only. Render supplies `PORT`; do not hard-code a production port.

Set these variables on the Render backend web service only. Keep all key and secret values out of the static frontend service, `VITE_*` variables, and committed files:

- `NODE_ENV=production`
- `SESSION_SECRET` (a long random value)
- `FRONTEND_URL=https://siconstableexam-1.onrender.com`
- `GOOGLE_DRIVE_ADMIN_KEY` (a separate random key used to authorize Drive management)
- Provider key/model pairs for the AI features in use, such as `GEMINI_API_KEY_1` / `GEMINI_MODEL_1`, `GROQ_API_KEY_1` / `GROQ_MODEL_1`, and `OPENROUTER_API_KEY_1` / `OPENROUTER_MODEL_1`. Numbered pairs through `_20` are supported.
- For Drive: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://siconstableexam-1.onrender.com/api/drive/oauth2callback`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`, and `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`.
- For durable token storage: `DATABASE_URL` for PostgreSQL, or `GOOGLE_DRIVE_TOKEN_FILE=/var/data/google-drive-token.enc` on a persistent disk. The current Free web instance does not support disks, and the default `.data/` path is not durable in production.
- Optional Drive settings: `DATABASE_SSL`, `GOOGLE_DRIVE_SHARED_DRIVE_ID`, and `GOOGLE_DRIVE_TOKEN_FILE_DURABLE=true` for a custom persistent mount.
- Optional OpenRouter site metadata: `OPENROUTER_SITE_URL`.

The static frontend rewrites `/api/*` to the backend, including the Google callback path. Register the exact frontend callback URI above in Google Cloud. PostgreSQL is the preferred durable token store; encrypted file storage is supported locally or on a persistent disk. This repository currently has no database provisioned, so configure `DATABASE_URL` or a persistent disk before connecting Drive in production. Keep `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` stable; changing it makes saved tokens unreadable.

Render dashboard configuration is managed in the dashboard; no duplicate `render.yaml` is included. See [GOOGLE_DRIVE_SETUP.md](GOOGLE_DRIVE_SETUP.md) and [RENDER_ENV.md](RENDER_ENV.md) for setup checklists.

## Requirements

- Node.js compatible with Vite 8 (Node.js 20.19+ or 22.12+ recommended).
- npm.
- API credentials for the AI features you intend to use.
- Google OAuth credentials and a configured Drive folder only if you intend to use Drive integration.

## Run locally on Windows

From the repository root, install the root/server dependencies and the frontend dependencies:

```powershell
npm install
npm install --prefix frontend
```

Create a local `.env` from `.env.example` for backend configuration. Add provider keys/models and optional Google Drive settings described below. AI features require their corresponding provider to be configured; the frontend and non-AI parts can still be explored without provider keys.

Open two terminals in the repository root:

```powershell
npm run dev:server
```

```powershell
npm run dev
```

Open the Vite URL printed in the second terminal, usually `http://localhost:5173`. The backend listens on port `8787` by default. To change it, set `PORT` or `AI_SERVER_PORT`; if you change the backend port, set `VITE_API_PROXY_TARGET` to its URL in a root `.env` file (for example, `http://localhost:9000`). Vite loads the root `.env` for `VITE_` variables.

The root `dev:all` script is available for environments that support its shell background syntax. On Windows, the two-terminal method above is the predictable option.

## Environment configuration

Keep `.env` at the repository root. Do not commit it or put server secrets in frontend variables. Only variables prefixed with `VITE_` are intended for the browser build.

### AI providers

Configure API key and model pairs for the provider used by each feature. Numbered entries are supported up to 20 per provider; each configured model is tried with the configured keys.

| Feature | Provider | Environment variables |
| --- | --- | --- |
| Practice question generation | Gemini | `GEMINI_API_KEY_1`, `GEMINI_MODEL_1` |
| Study note generation | Groq | `GROQ_API_KEY_1`, `GROQ_MODEL_1` |
| Study chat | OpenRouter | `OPENROUTER_API_KEY_1`, `OPENROUTER_MODEL_1` |

Additional pairs can use suffixes `_2` through `_20`, for example `GEMINI_API_KEY_2` and `GEMINI_MODEL_2`. Configure models supported by the corresponding provider.

### Google Drive (optional)

Google Drive uses OAuth 2.0 and the Google account that owns or can access the Notes Library. Learner profiles are browser-local, not server-authenticated identities, so Drive is intentionally a global administrator-managed library. Set the local Google OAuth redirect URI to `http://localhost:8787/api/drive/oauth2callback`; use the production callback in [GOOGLE_DRIVE_SETUP.md](GOOGLE_DRIVE_SETUP.md).

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Must match the redirect URI configured with Google; use the local URL above for development |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | ID of the Drive folder used as the notes library root |
| `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` | 32-byte key, encoded as base64 or 64 hexadecimal characters, used to encrypt the saved refresh token |
| `GOOGLE_DRIVE_ADMIN_KEY` | Backend-only key used to create an expiring HTTP-only administrator session for Drive management |
| `DATABASE_URL` | PostgreSQL URL for encrypted persistent OAuth-token storage; required for durable storage without a persistent disk |
| `DATABASE_SSL` | Set to `true` when the PostgreSQL provider requires TLS |
| `GOOGLE_DRIVE_SHARED_DRIVE_ID` | Optional shared-drive ID when the library is in a shared drive |
| `GOOGLE_DRIVE_TOKEN_FILE` | Optional encrypted token file; defaults to `.data/google-drive-token.enc` for local development only |

The connected account needs permission to read the root folder; creating folders, uploads, and deletes require Editor access. The existing library contains files not necessarily created by this app, so the Drive scope is required for listing and managing those files. PostgreSQL stores an encrypted token payload plus expiry/scope metadata; file fallback uses AES-256-GCM. Keep the encryption key stable. `.data/` is excluded from Git and must not be used as durable production storage.

### Other settings

| Variable | Purpose |
| --- | --- |
| `PORT` or `AI_SERVER_PORT` | Express listen port; defaults to `8787` (`PORT` takes precedence) |
| `SESSION_SECRET` | Required in production; signs short-lived OAuth state and administrator sessions. In development, a temporary value is generated if omitted. |
| `FRONTEND_URL` | Frontend URL used after Google OAuth; defaults to `http://localhost:5173` |
| `VITE_API_PROXY_TARGET` | Development proxy target for `/api`; defaults to `http://localhost:8787` |
| `VITE_API_BASE_URL` | Optional API base URL used by the browser client; defaults to same-origin paths |

## Where data is stored

- **Browser (`localStorage`):** local learner profiles, active profile, password salt/hash, study progress, test history, question counters, and planner data. This data is tied to the browser profile and origin; it is not synchronized to the server and can be removed by clearing site data. The app's local profiles are for organizing study data, not a server-backed identity or account system.
- **Google Drive:** uploaded notes and the folder/file library are stored in the configured Drive account. The app accesses them through the backend; it does not keep uploaded notes in its own database.
- **Backend token storage:** encrypted PostgreSQL record when `DATABASE_URL` is configured; otherwise encrypted `.data/google-drive-token.enc` locally or an explicitly mounted persistent file in production.
- **Backend memory:** transient AI/provider state only; OAuth state and administrator sessions are signed and do not depend on the Render process memory.
- **AI providers:** requests are sent from the backend to the configured provider. API keys stay server-side; provider availability, quotas, and billing are controlled by those providers.

No application database is currently configured. Browser study data, encrypted Drive token storage, and the actual Drive library are separate storage locations. PostgreSQL support is used for durable Drive token storage when `DATABASE_URL` is provided; it does not migrate browser-local progress.

## Build, test, and lint

Run these commands from the repository root:

```powershell
npm test
npm run build
npm --prefix frontend run lint
```

`npm test` runs the Node.js backend tests and the frontend utility tests. `npm run build` creates the production frontend in `frontend/dist`. `npm run preview` starts Vite's static preview server for the built frontend; it does not start the Express API, so use the backend as well when testing API-backed features.

To run the production-style Express server locally after building:

```powershell
npm run build
npm run dev:server
```

Then open `http://localhost:8787`. Set `NODE_ENV=production` only with an explicit `SESSION_SECRET` and the deployment-appropriate secure-cookie/HTTPS setup.

## Repository layout

```text
frontend/
  src/
    App.jsx                 Main study application and local learner state
    services/aiService.js   Browser API client for AI and Google Drive
    planner-utils.js        Study-plan calculations
    test-results.js         Test scoring and answer normalization
  public/                   Static frontend assets
server/
  index.mjs                 Express API, OAuth callback, and static hosting
  ai-service.mjs            AI request construction and response validation
  provider-manager.mjs      AI provider configuration and error handling
  google-drive-service.mjs  Drive API, OAuth token handling, and file storage
```