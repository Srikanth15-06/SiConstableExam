# TS Police AI Prep

A browser-based study and exam-preparation app for Telangana Police SI and Constable candidates. It combines syllabus-based practice, AI-generated learning material, progress tracking, a study planner, and an optional Google Drive notes library.

## What the project contains

This repository has two separately installed parts:

- `frontend/` is the React 19 application built with Vite. It presents the study experience and calls the backend through `/api` requests.
- `server/` is a Node.js ES module application built on Express. It exposes the AI and Google Drive APIs, keeps the Google OAuth callback/session, and serves the built frontend in production.
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
- `/api/drive/*` for Google OAuth, Drive status, folder browsing/creation, file uploads, and file content.
- `/api/health` for a basic server health check.

For production, build the frontend and run the Express server. It serves static files from `frontend/dist` and falls back to the frontend entry page for app routes.

## Render deployment

The production web service serves both the frontend and API from one origin. Configure Render with the repository root as the Root Directory, `main` as the branch, this build command, and the Node start command:

```text
Build:  npm install && npm --prefix frontend install && npm run build
Start:  npm run dev:server
```

`node server/index.mjs` is equivalent to the start command above. Render supplies `PORT` and `RENDER_EXTERNAL_URL`; do not hard-code a production port. Leave `VITE_API_BASE_URL` unset for the single-origin deployment so the browser requests `/api/...` on the same host. `VITE_API_PROXY_TARGET` is for local Vite development only.

Set these server-side variables in the Render web service. Keep all key and secret values in Render's environment settings, never in `VITE_*` variables or committed files:

- `NODE_ENV=production`
- `SESSION_SECRET` (a long random value)
- `FRONTEND_URL=https://srikanthsiexam.onrender.com`
- Provider key/model pairs for the AI features in use, such as `GEMINI_API_KEY_1` / `GEMINI_MODEL_1`, `GROQ_API_KEY_1` / `GROQ_MODEL_1`, and `OPENROUTER_API_KEY_1` / `OPENROUTER_MODEL_1`. Numbered pairs through `_20` are supported.
- For Drive: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://srikanthsiexam.onrender.com/api/drive/oauth2callback`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`, and `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`.
- Optional Drive settings: `GOOGLE_DRIVE_SHARED_DRIVE_ID` and `GOOGLE_DRIVE_TOKEN_FILE`.
- Optional OpenRouter site metadata: `OPENROUTER_SITE_URL`.

Register the exact Drive redirect URI above in Google Cloud OAuth settings. The server can derive the frontend callback destination from Render's `RENDER_EXTERNAL_URL` when `FRONTEND_URL` is omitted. Drive refresh tokens are encrypted in `.data/` by default; Render's ephemeral filesystem does not preserve them across restarts, so reconnect Drive after token loss or use durable storage.

The current Render dashboard configuration uses the repository root, the build command above, and `node server/index.mjs` as its start command. A `render.yaml` is intentionally not included because it would duplicate the already-managed dashboard service configuration.

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

Create a `.env` file in the repository root for backend configuration. Add the provider keys/models and optional Google Drive settings described below. AI features require their corresponding provider to be configured; the frontend and non-AI parts can still be explored without provider keys.

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

Google Drive integration requires a Google Cloud OAuth client, the Drive API enabled for that project, and a folder the connected Google account can access. Set the OAuth redirect URI in Google Cloud to `http://localhost:8787/api/drive/oauth2callback` for local development.

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Must match the redirect URI configured with Google; use the local URL above for development |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | ID of the Drive folder used as the notes library root |
| `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` | 32-byte key, encoded as base64 or 64 hexadecimal characters, used to encrypt the saved refresh token |
| `GOOGLE_DRIVE_SHARED_DRIVE_ID` | Optional shared-drive ID when the library is in a shared drive |
| `GOOGLE_DRIVE_TOKEN_FILE` | Optional token file path; defaults to `.data/google-drive-token.enc` |

The connected account needs permission to read the root folder; creating folders or uploading files requires Editor access. The server stores the refresh token encrypted on disk. Back up and protect both the token file and its encryption key; losing the key means the saved token cannot be decrypted. `.data/` is excluded from Git.

### Other settings

| Variable | Purpose |
| --- | --- |
| `PORT` or `AI_SERVER_PORT` | Express listen port; defaults to `8787` (`PORT` takes precedence) |
| `SESSION_SECRET` | Express session signing secret; required when `NODE_ENV=production`. In development, a temporary secret is generated if omitted. |
| `FRONTEND_URL` | Frontend URL used after Google OAuth; defaults to `http://localhost:5173` |
| `VITE_API_PROXY_TARGET` | Development proxy target for `/api`; defaults to `http://localhost:8787` |
| `VITE_API_BASE_URL` | Optional API base URL used by the browser client; defaults to same-origin paths |

## Where data is stored

- **Browser (`localStorage`):** local learner profiles, active profile, password salt/hash, study progress, test history, question counters, and planner data. This data is tied to the browser profile and origin; it is not synchronized to the server and can be removed by clearing site data. The app's local profiles are for organizing study data, not a server-backed identity or account system.
- **Google Drive:** uploaded notes and the folder/file library are stored in the configured Drive account. The app accesses them through the backend; it does not keep uploaded notes in its own database.
- **Backend filesystem:** the encrypted Google Drive OAuth token is stored at `.data/google-drive-token.enc` by default. Set `GOOGLE_DRIVE_TOKEN_FILE` to change this location.
- **Backend memory:** the Express session store and transient AI/provider state are in memory. The default Express session store is suitable for local development, not durable production sessions.
- **AI providers:** requests are sent from the backend to the configured provider. API keys stay server-side; provider availability, quotas, and billing are controlled by those providers.

There is no application database configured in this project. Browser study data, the encrypted Drive token file, and the actual Drive library are separate storage locations.

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