# Google Drive Notes Library

Google Drive remains the optional file library for notes. Accounts, sessions, progress, quizzes, and planner data use Supabase and do not depend on Google OAuth.

The library continues to use the existing Google account `websriweb@gmail.com` and existing root `1rz_XI2AkAkQNfrsbKW9Rs78xSptWFJ1z`. The app does not create another root or move Drive files.

## OAuth Configuration

When enabling Notes Library access, configure the existing Google OAuth web client with this production callback:

`https://siconstableexam-1.onrender.com/api/drive/oauth2callback`

For local development, use `http://localhost:8787/api/drive/oauth2callback`. Keep `GOOGLE_CLIENT_SECRET` and all other credentials on the backend; never use `VITE_*` variables for secrets.

Backend Drive variables are optional for basic application startup:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_DRIVE_ROOT_FOLDER_ID` (must remain the existing root ID above)
- `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`
- `GOOGLE_DRIVE_ADMIN_KEY`

Google Drive tokens are encrypted with AES-256-GCM and stored in Supabase. No Google service-account credential, Secret Manager, token file, or Render disk is required. If Supabase or Google OAuth is unavailable, app accounts and progress remain available; Notes Library operations report their own error.

## Access and Troubleshooting

The existing Google account needs read access to the root. Folder creation, renaming, uploads, and deletes require Editor permission. File and folder renaming is available to site administrators in the Notes Library. The configured root must be a folder and is never changed by the app.

Check `/api/drive/status` for safe readiness booleans. `DRIVE_AUTH_FAILED` or `DRIVE_AUTH_REVOKED` means reconnect the existing Google account. `GOOGLE_REDIRECT_URI_MISMATCH` means the OAuth callback does not match the production URI above. `DRIVE_PERMISSION_DENIED` means the account lacks permission on the existing library. Supabase database failures affect account persistence and are reported by `/api/health`; they do not imply that Drive files were moved or deleted.