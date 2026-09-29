import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import { Pool } from 'pg';

const TOKEN_PROVIDER = 'google-drive';
const TOKEN_VAULT_FILE_NAME = '.ts-constable-drive-oauth-token.enc';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
let pool;
let tableReady;
let vaultAuth;

function getEncryptionKey() {
    const encodedKey = (process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY || '').trim();
    const key = /^[a-f\d]{64}$/i.test(encodedKey)
        ? Buffer.from(encodedKey, 'hex')
        : Buffer.from(encodedKey, 'base64');
    if (key.length !== 32) {
        const error = new Error('Set GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY to a 32-byte base64 or 64-character hex key.');
        error.code = 'MISSING_DRIVE_TOKEN_ENCRYPTION_KEY';
        throw error;
    }
    return key;
}

function getTokenFilePath() {
    return path.resolve(process.cwd(), process.env.GOOGLE_DRIVE_TOKEN_FILE || '.data/google-drive-token.enc');
}

function getDriveRootFolderId() {
    return (process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || process.env.ROOT_FOLDER_ID || '').trim();
}

function getVaultServiceAccount() {
    const value = (process.env.GOOGLE_DRIVE_TOKEN_VAULT_SERVICE_ACCOUNT_JSON || '').trim();
    if (!value) return null;
    try {
        const credentials = JSON.parse(value);
        return credentials.type === 'service_account' && credentials.client_email && credentials.private_key
            ? credentials
            : null;
    } catch {
        return null;
    }
}

function isDriveVaultConfigured() {
    return Boolean(getDriveRootFolderId() && getVaultServiceAccount());
}

export function getGoogleDriveTokenStorageStatus() {
    let encryptionKeyConfigured = true;
    try {
        getEncryptionKey();
    } catch {
        encryptionKeyConfigured = false;
    }
    if (process.env.DATABASE_URL?.trim()) {
        return { configured: encryptionKeyConfigured, durable: true, provider: 'postgres', encryptionKeyConfigured };
    }
    if (isDriveVaultConfigured()) {
        return { configured: encryptionKeyConfigured, durable: true, provider: 'google-drive-vault', encryptionKeyConfigured };
    }
    const tokenFilePath = process.env.GOOGLE_DRIVE_TOKEN_FILE?.trim();
    const mountedFile = tokenFilePath?.replace(/\\/g, '/').startsWith('/var/data/');
    const explicitlyDurable = process.env.GOOGLE_DRIVE_TOKEN_FILE_DURABLE === 'true';
    const localDevelopment = process.env.NODE_ENV !== 'production';
    return {
        configured: encryptionKeyConfigured && (localDevelopment || Boolean(tokenFilePath && (mountedFile || explicitlyDurable))),
        durable: localDevelopment || Boolean(tokenFilePath && (mountedFile || explicitlyDurable)),
        provider: 'encrypted-file',
        encryptionKeyConfigured
    };
}

function encryptToken(token) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final()]);
    return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64')
    };
}

function decryptToken(envelope) {
    const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
}

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ...(process.env.DATABASE_SSL === 'true'
                ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } }
                : {})
        });
    }
    return pool;
}

async function ensureDatabaseTable() {
    if (!tableReady) {
        tableReady = getPool().query(`
            CREATE TABLE IF NOT EXISTS google_drive_oauth_tokens (
                provider TEXT PRIMARY KEY,
                token_ciphertext JSONB NOT NULL,
                expires_at BIGINT,
                scope TEXT,
                token_type TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `).catch((error) => {
            tableReady = null;
            throw error;
        });
    }
    await tableReady;
}

function getVaultAuth() {
    if (!vaultAuth) {
        vaultAuth = new google.auth.GoogleAuth({
            credentials: getVaultServiceAccount(),
            scopes: [DRIVE_SCOPE]
        });
    }
    return vaultAuth;
}

function vaultRequestUrl(url, isList = false) {
    url.searchParams.set('supportsAllDrives', 'true');
    if (isList) url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (isList && process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim()) {
        url.searchParams.set('corpora', 'drive');
        url.searchParams.set('driveId', process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID.trim());
    }
    return url;
}

async function fetchDriveVault(url, options = {}, isList = false, accessTokenOverride = '') {
    try {
        let accessToken = accessTokenOverride;
        if (!accessToken) {
            const client = await getVaultAuth().getClient();
            const credentials = await client.getAccessToken();
            accessToken = typeof credentials === 'string' ? credentials : credentials?.token;
        }
        if (!accessToken) throw new Error('missing access token');
        const response = await fetch(vaultRequestUrl(url, isList), {
            ...options,
            headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` }
        });
        if (!response.ok) throw new Error('Drive API request failed');
        return response;
    } catch {
        const error = new Error('The encrypted Drive token vault is unavailable. Verify that its service account can access the configured root folder.');
        error.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        throw error;
    }
}

async function listVaultFiles() {
    const rootFolderId = getDriveRootFolderId();
    if (!rootFolderId) {
        const error = new Error('The Google Drive Notes Library root is not configured for token storage.');
        error.code = 'DRIVE_TOKEN_STORAGE_NOT_CONFIGURED';
        throw error;
    }
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    const escapedName = TOKEN_VAULT_FILE_NAME.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    url.searchParams.set('q', `name = '${escapedName}' and trashed = false`);
    url.searchParams.set('corpora', 'user');
    url.searchParams.set('pageSize', '10');
    url.searchParams.set('fields', 'files(id,name,mimeType,parents)');
    const response = await fetchDriveVault(url, {}, true);
    const data = await response.json().catch(() => ({}));
    return Array.isArray(data.files)
        ? data.files.filter((file) => file.name === TOKEN_VAULT_FILE_NAME && file.parents?.includes(rootFolderId))
        : [];
}

async function readDriveVaultToken() {
    const [file] = await listVaultFiles();
    if (!file) return null;
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
    url.searchParams.set('alt', 'media');
    const response = await fetchDriveVault(url);
    return decryptToken(JSON.parse(await response.text()));
}

async function writeDriveVaultToken(envelope, oauthAccessToken) {
    const [existingFile] = await listVaultFiles();
    const serializedEnvelope = JSON.stringify(envelope);
    if (existingFile) {
        const url = new URL(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFile.id)}`);
        url.searchParams.set('uploadType', 'media');
        await fetchDriveVault(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: serializedEnvelope
        });
        return;
    }

    const boundary = `drive-token-vault-${randomUUID()}`;
    const metadata = JSON.stringify({
        name: TOKEN_VAULT_FILE_NAME,
        mimeType: 'application/octet-stream',
        parents: [getDriveRootFolderId()],
        description: 'Encrypted OAuth token storage managed by TS Police AI Prep.'
    });
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
        Buffer.from(serializedEnvelope),
        Buffer.from(`\r\n--${boundary}--`)
    ]);
    const url = new URL('https://www.googleapis.com/upload/drive/v3/files');
    url.searchParams.set('uploadType', 'multipart');
    url.searchParams.set('fields', 'id');
    const initialAccessToken = String(oauthAccessToken || '');
    const serviceAccount = getVaultServiceAccount();
    if (!initialAccessToken || !serviceAccount?.client_email) {
        const error = new Error('A user OAuth access token is required to initialize the encrypted Drive token vault.');
        error.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        throw error;
    }
    const createResponse = await fetchDriveVault(url, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
    }, false, initialAccessToken);
    const createdFile = await createResponse.json().catch(() => ({}));
    if (!createdFile.id) {
        const error = new Error('The encrypted Drive token vault could not be initialized.');
        error.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        throw error;
    }
    const permissionUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(createdFile.id)}/permissions`);
    permissionUrl.searchParams.set('sendNotificationEmail', 'false');
    await fetchDriveVault(permissionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: serviceAccount.client_email })
    }, false, initialAccessToken);
}

async function deleteDriveVaultToken() {
    for (const file of await listVaultFiles()) {
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
        await fetchDriveVault(url, { method: 'DELETE' });
    }
}

export async function getStoredGoogleDriveToken() {
    if (process.env.GOOGLE_DRIVE_TOKEN && process.env.NODE_ENV !== 'production') {
        try {
            return JSON.parse(process.env.GOOGLE_DRIVE_TOKEN);
        } catch {
            const error = new Error('The configured Google Drive token is not valid JSON.');
            error.code = 'DRIVE_TOKEN_STORAGE_FAILED';
            throw error;
        }
    }

    try {
        if (process.env.DATABASE_URL?.trim()) {
            await ensureDatabaseTable();
            const result = await getPool().query(
                'SELECT token_ciphertext FROM google_drive_oauth_tokens WHERE provider = $1',
                [TOKEN_PROVIDER]
            );
            return result.rows[0] ? decryptToken(result.rows[0].token_ciphertext) : null;
        }
        if (isDriveVaultConfigured()) return await readDriveVaultToken();

        const envelope = JSON.parse(await readFile(getTokenFilePath(), 'utf8'));
        return decryptToken(envelope);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'MISSING_DRIVE_TOKEN_ENCRYPTION_KEY' || error.code === 'DRIVE_TOKEN_STORAGE_FAILED') throw error;
        const storageError = new Error('The saved Google Drive authorization could not be read. Check database access or the token encryption key, then reconnect if needed.');
        storageError.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        throw storageError;
    }
}

export async function storeGoogleDriveToken(token) {
    const envelope = encryptToken(token);
    try {
        if (process.env.DATABASE_URL?.trim()) {
            await ensureDatabaseTable();
            await getPool().query(`
                INSERT INTO google_drive_oauth_tokens (provider, token_ciphertext, expires_at, scope, token_type, updated_at)
                VALUES ($1, $2::jsonb, $3, $4, $5, NOW())
                ON CONFLICT (provider) DO UPDATE SET
                    token_ciphertext = EXCLUDED.token_ciphertext,
                    expires_at = EXCLUDED.expires_at,
                    scope = EXCLUDED.scope,
                    token_type = EXCLUDED.token_type,
                    updated_at = NOW()
            `, [TOKEN_PROVIDER, JSON.stringify(envelope), token.expiry || null, token.scope || null, token.token_type || null]);
            return;
        }
        if (isDriveVaultConfigured()) {
            await writeDriveVaultToken(envelope, token.access_token);
            return;
        }

        const tokenFilePath = getTokenFilePath();
        await mkdir(path.dirname(tokenFilePath), { recursive: true });
        const temporaryPath = `${tokenFilePath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(envelope), { mode: 0o600 });
        await rename(temporaryPath, tokenFilePath);
    } catch (error) {
        if (error.code === 'MISSING_DRIVE_TOKEN_ENCRYPTION_KEY') throw error;
        const storageError = new Error('The Google Drive authorization could not be saved. Check database access or persistent token-file storage.');
        storageError.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        throw storageError;
    }
}

export async function clearStoredGoogleDriveToken() {
    if (process.env.DATABASE_URL?.trim()) {
        await ensureDatabaseTable();
        await getPool().query('DELETE FROM google_drive_oauth_tokens WHERE provider = $1', [TOKEN_PROVIDER]);
        return;
    }
    if (isDriveVaultConfigured()) {
        await deleteDriveVaultToken();
        return;
    }
    try {
        await unlink(getTokenFilePath());
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}