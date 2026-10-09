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
- Use the dashboard's **Syllabus Modules → All · Revision Mock Tests** entry to create a 10-, 20-, 30-, 40-, 50-, 60-, 90-, or 120-minute test with 10, 20, 30, 40, 50, 60, 90, or 120 questions sampled from practiced topics across subjects. Topic selection prioritizes syllabus weightage and areas needing revision; repeat mocks rotate through the practiced-topic pool. Scores update each topic's progress independently.
- Run an **Exam-day simulation** from the same screen. It defaults to a 120-question, 120-minute practice run and cycles through the app's subject order using practiced topics; it is an approximate simulation, not an official exam blueprint.
- Use **Profile & History** for a mistake notebook, accuracy-adaptive spaced-revision reminders, test-performance trends and topic insights, and average pacing.
- Save questions from result reviews and assemble timed custom practice sets from saved questions. Saved items are account-specific and capped at 100 per account.
- Export progress as CSV or JSON, print a profile report, and adjust browser-local text size and high-contrast preferences. Reviewed questions also offer AI-generated Telugu explanations.
- Track topic progress and use the Smart Study Planner for revision and manual tasks.
- Generate an AI-ranked full-syllabus schedule personalized to exam role, remaining days, daily study time, topic completion, accuracy, practice activity, and exam weightage. The schedule assigns every syllabus topic, adjusts session lengths when time is tight, and refreshes as progress changes.
- Connect Google Drive to browse folders with file/page thumbnails, preview or download notes, provision folders, upload supported files (up to 20 MB), and rename files or folders as a site administrator.
- Secure candidate accounts with Supabase-backed sessions, progress, test history, planner data, and saved questions.

## Architecture and requests

During development, Vite normally runs at `http://localhost:5173`. Its `/api` proxy forwards requests to the Express server at `http://localhost:8787` (configurable with `VITE_API_PROXY_TARGET`). The browser-side API client can use `VITE_API_BASE_URL` when a different API base URL is needed.

The Express server provides these API groups:

- `/api/ai/*` for AI provider status, question generation, notes, and chat.
- `/api/drive/auth`, `/api/drive/oauth2callback`, `/api/drive/status`, and `/api/drive/test` for OAuth and diagnostics.
- `/api/drive/folders`, `/api/drive/upload`, `/api/drive/files`, and `/api/drive/files/:id` for root-scoped Notes Library operations.
- `/api/drive/admin/session` for administrator sign-in/out; mutating Drive operations require its HTTP-only session.
- `/api/auth/*` for candidate signup/login/session/logout, `/api/me/*` for the authenticated account snapshot and planner/profile, and `/api/tests/*` for server-created and server-scored attempts.
- `/api/health` for a safe Supabase configuration/reachability readiness check.

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
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for backend persistence. `SUPABASE_ANON_KEY` may be configured for tooling, but this app does not connect to Supabase from the browser.
- `SESSION_SECRET` (a long random value; sessions are persisted as hashes in Supabase).
- Provider key/model pairs for AI features, such as `GEMINI_API_KEY_1` / `GEMINI_MODEL_1`, `GROQ_API_KEY_1` / `GROQ_MODEL_1`, and `OPENROUTER_API_KEY_1` / `OPENROUTER_MODEL_1`. Numbered pairs through `_20` are supported.
- Optional Google Drive Notes Library settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://siconstableexam-1.onrender.com/api/drive/oauth2callback`, the existing `GOOGLE_DRIVE_ROOT_FOLDER_ID=1rz_XI2AkAkQNfrsbKW9Rs78xSptWFJ1z`, `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`, and `GOOGLE_DRIVE_ADMIN_KEY`.
- Google OAuth and Drive token storage are optional for application login/progress. If enabled, OAuth tokens are AES-256-GCM encrypted in Supabase; no service-account JSON, `GOOGLE_DRIVE_TOKEN_FILE`, external database, or persistent disk is required.
- Optional Drive setting: `GOOGLE_DRIVE_SHARED_DRIVE_ID` (not required for the existing My Drive folder).
- Optional OpenRouter site metadata: `OPENROUTER_SITE_URL`.

The static frontend rewrites `/api/*` to the backend, including the Google callback path. Register the exact frontend callback URI above in Google Cloud when enabling Notes Library OAuth. Candidate accounts, password hashes, sessions, progress, planner records, attempts, answers, and history are persisted in Supabase by the backend. The browser never receives the service-role key. Drive files remain in the existing Notes Library root and are accessed only by the OAuth identity `websriweb@gmail.com`.

Render dashboard configuration is managed in the dashboard; no duplicate `render.yaml` is included. See [GOOGLE_DRIVE_SETUP.md](GOOGLE_DRIVE_SETUP.md) and [RENDER_ENV.md](RENDER_ENV.md) for setup checklists.

## Requirements

- Node.js compatible with Vite 8 (Node.js 20.19+ or 22.12+ recommended).
- npm.
- A Supabase project and backend-only service-role key for durable account/application persistence.
- API credentials for the AI features you intend to use.
- Google OAuth credentials only if you want to enable the separate Notes Library integration.

## Run locally on Windows

From the repository root, install the root/server dependencies and the frontend dependencies:

```powershell
npm install
npm install --prefix frontend
```

Configure the ignored repository-root `.env` file for backend settings. Do not commit it. Apply the SQL migration in `supabase/migrations/` to a fresh Supabase project, then configure its URL and service-role key only on the backend. Add provider keys/models as needed; AI providers and Google Drive Notes are optional for account persistence.

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

### Supabase persistence

Candidate accounts, persistent HTTP-only sessions, progress, quiz attempts/history, and planner state are stored in Supabase. Apply the SQL migration in `supabase/migrations/` to a fresh project before starting the backend.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL; backend only |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged server key; backend only, never a `VITE_*` variable |
| `SUPABASE_ANON_KEY` | Optional public project key; this application does not use it in the browser |

The backend uses parameterized Supabase/PostgREST requests and fixed RPCs for atomic state updates. RLS is enabled and browser roles have no table/function access; only the backend service role can access application data. Sessions persist only a hash of the random cookie token.

### Google Drive Notes Library (optional)

Google Drive remains a separate OAuth-backed Notes Library using the existing Google account and root. Candidate profiles are server-authenticated and do not depend on Drive OAuth. Set the local callback to `http://localhost:8787/api/drive/oauth2callback`; use the production callback in [GOOGLE_DRIVE_SETUP.md](GOOGLE_DRIVE_SETUP.md).

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Must match the redirect URI configured with Google; use the local URL above for development |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | Existing Notes Library root ID: `1rz_XI2AkAkQNfrsbKW9Rs78xSptWFJ1z` |
| `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` | 32-byte key, encoded as base64 or 64 hexadecimal characters, used to encrypt the OAuth token stored in Supabase |
| `GOOGLE_DRIVE_ADMIN_KEY` | Backend-only key used to create an expiring HTTP-only administrator session for Drive management |
| `GOOGLE_DRIVE_SHARED_DRIVE_ID` | Optional shared-drive ID when the library is in a shared drive |

The connected account needs permission to read the existing root folder; creating folders, uploads, and deletes require Editor access. Drive tokens are AES-256-GCM encrypted before they are stored in the Supabase `drive_oauth_tokens` table. Google Drive files remain in Drive; Supabase does not move or delete them. If Supabase or Drive OAuth is unavailable, account login/progress remains separate, while Notes Library requests report a Drive-specific error.

### Other settings

| Variable | Purpose |
| --- | --- |
| `PORT` or `AI_SERVER_PORT` | Express listen port; defaults to `8787` (`PORT` takes precedence) |
| `SESSION_SECRET` | Required in production; signs OAuth state and Drive administrator sessions. Candidate sessions are persisted by token hash in Supabase. |
| `FRONTEND_URL` | Frontend URL used after Google OAuth; defaults to `http://localhost:5173` |
| `VITE_API_PROXY_TARGET` | Development proxy target for `/api`; defaults to `http://localhost:8787` |
| `VITE_API_BASE_URL` | Optional API base URL used by the browser client; defaults to same-origin paths |

## Where data is stored

- **Supabase:** accounts, bcrypt password hashes, hashed sessions, progress, attempts, answers/results, planner, and history. A Postgres RPC updates the canonical per-user state and normalized projections atomically with revision checks.
- **Browser memory:** authenticated profile and progress snapshots are held in React state only. They are fetched from the backend after refresh/login; no credential, answer key, or progress authority is stored in browser storage.
- **Google Drive:** uploaded notes and the folder/file library remain in the configured Drive account and are accessed through the backend.
- **Drive OAuth token:** AES-256-GCM encrypted in Supabase; no service-account credential or Render filesystem token persistence is required.
- **Backend memory:** transient AI/provider state only; OAuth state and administrator sessions are signed and do not depend on the Render process memory.
- **AI providers:** requests are sent from the backend to the configured provider. API keys stay server-side; provider availability, quotas, and billing are controlled by those providers.

Render Free does not need a persistent disk. Supabase is the durable application datastore; Google Drive remains the separate Notes Library file store.

Legacy browser-local profiles are not automatically imported. Their stored scores and answer keys were client-controlled and cannot be verified by the server; users must create a server-backed account. The old local browser data is not read by the new app flow.

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