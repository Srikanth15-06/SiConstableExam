# Google Drive Setup

This application uses OAuth 2.0 for the administrator account that owns or can access the shared Notes Library. It does not use service-account storage or require a Shared Drive. Learner profiles remain browser-local; the Drive library is global and administrator-managed.

## Google Cloud

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and select the project used by this app.
2. Open **APIs & Services > Library**, find **Google Drive API**, and enable it.
3. Open **Google Auth Platform > Branding** and configure the app name, support email, and developer contact.
4. Open **Google Auth Platform > Audience**. Choose **External** for consumer Google accounts. While the app is in Testing, add the Drive-owning Google account under Test users. Publish the consent screen when the app is ready for general production use.
5. Open **Google Auth Platform > Data Access** and add the Drive scope `https://www.googleapis.com/auth/drive`. The current Notes Library lists existing files in a preconfigured folder, creates folders, uploads, and deletes; the narrower `drive.file` scope cannot reliably access existing library files that were not created/opened through this app.
6. Open **Google Auth Platform > Clients > Create client** and choose **Web application**.
7. Add this exact production authorized redirect URI:

   `https://siconstableexam-1.onrender.com/api/drive/oauth2callback`

   The Render static site rewrites `/api/*` to the Node backend, so this frontend-host callback reaches the Express OAuth callback without changing the browser URL.
8. For local development, also add:

   `http://localhost:8787/api/drive/oauth2callback`

9. Copy the OAuth Client ID and Client Secret into the **backend web service** environment in Render. Never put either value in the static frontend or a `VITE_*` variable.

## Render and Storage

1. Configure the backend variables listed in [RENDER_ENV.md](RENDER_ENV.md), including `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`, and `GOOGLE_DRIVE_ADMIN_KEY`.
2. Configure durable token storage with `DATABASE_URL` (PostgreSQL), a persistent disk mounted at `/var/data`, or the Render Free token-vault fallback below. Do not rely on `.data/` across restarts.
3. Keep `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` stable. Generate a 32-byte key in a trusted local terminal with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`, then put it directly into Render's environment settings. Do not send it in chat or commit it.
4. Set `GOOGLE_DRIVE_ADMIN_KEY` to a separate long random value. The administrator enters it in the Notes Library UI; the browser does not store it. The server issues an expiring HTTP-only session cookie.
5. Ensure the Google account can at least read the configured root folder. Folder creation, uploads, and deletes require Editor permission.
6. Redeploy the backend after environment changes. Open `https://siconstableexam-1.onrender.com/`, open **Notes Library**, enter the administrator key, select **Unlock management**, then choose **Connect Google Drive** and authorize the correct Google account.
7. Check `GET https://siconstableexam-1.onrender.com/api/drive/status` and `GET https://siconstableexam-1.onrender.com/api/drive/test`. A ready status reports `available: true`, `authenticated: true`, `rootFolderAccessible: true`, and `checks.listFiles: true`.
8. Upload a small PDF, refresh the folder, open/download it, and remove it to verify the complete lifecycle.

### Render Free token-vault fallback

Set `GOOGLE_DRIVE_TOKEN_VAULT_SERVICE_ACCOUNT_JSON` on the backend to the JSON key for an existing service account that has Editor access to the configured root. Keep the JSON private and out of Git and frontend variables. The service account is used only to read/write/delete the encrypted token vault; all Notes Library access continues to use the OAuth authorization for `websriweb@gmail.com`.

The vault creates one reserved `application/octet-stream` file named `.ts-constable-drive-oauth-token.enc` inside the existing root. The app does not list it as a note. Do not delete or rename it manually; administrator disconnect removes it. This avoids Postgres and a Render disk, but it does modify the existing root contents. If no existing service account has Editor access or an available key, use another durable token store instead.

## Troubleshooting

| Code | Likely cause | Action |
| --- | --- | --- |
| `DRIVE_TOKEN_STORAGE_NOT_CONFIGURED` | No durable token store is configured | Configure `DATABASE_URL`, a mounted durable disk, or the existing-root token vault |
| `AUTH_REQUIRED` | No refresh token is stored | Unlock as administrator and reconnect Google Drive |
| `DRIVE_AUTH_REVOKED` | Google returned `invalid_grant` | Revoke the app in Google Account security settings and reconnect |
| `GOOGLE_REDIRECT_URI_MISMATCH` | Redirect URL differs between Render and Google Cloud | Match the production URI exactly, including HTTPS and path |
| `GOOGLE_INVALID_CLIENT` | Client ID/secret pair is wrong | Correct the backend-only OAuth variables |
| `DRIVE_API_NOT_ENABLED` | Drive API is disabled in the selected project | Enable Google Drive API in that same project |
| `FOLDER_ACCESS_FAILED` | Account cannot read the configured folder or it is not a folder | Share the folder with the authorized Google account and verify its ID |
| `DRIVE_PERMISSION_DENIED` | Account lacks permission for a write operation | Grant Editor access to the root/library folders |
| `DRIVE_RATE_LIMITED` | Google API request quota was reached | Wait and retry; review Google Cloud quotas |

The OAuth refresh token and access token are never returned to the browser. No service-account email/private key is used. The app's local learner profiles are not server-side identities; Drive access is intentionally a single global administrator library.