import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import { getSupabaseClient, isSupabaseConfigured } from './supabase-client.mjs';

const TOKEN_VAULT_FILE_NAME = '.ts-constable-drive-oauth-token.enc';
const TOKEN_PROVIDER = 'google-drive';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
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

function isRenderEnvironment() {
    return process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID);
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
    if (isSupabaseConfigured()) {
        return { configured: encryptionKeyConfigured, durable: true, provider: 'supabase-encrypted', encryptionKeyConfigured };
    }
    if (isDriveVaultConfigured()) {
        return { configured: encryptionKeyConfigured, durable: true, provider: 'google-drive-vault', encryptionKeyConfigured };
    }
    const tokenFilePath = process.env.GOOGLE_DRIVE_TOKEN_FILE?.trim();
    const mountedFile = tokenFilePath?.replace(/\\/g, '/').startsWith('/var/data/');
    const explicitlyDurable = process.env.GOOGLE_DRIVE_TOKEN_FILE_DURABLE === 'true';
    const localDevelopment = process.env.NODE_ENV !== 'production' && !isRenderEnvironment();
    const fileDurable = localDevelopment && Boolean(tokenFilePath && (mountedFile || explicitlyDurable));
    return {
        configured: encryptionKeyConfigured && localDevelopment,
        durable: fileDurable,
        provider: localDevelopment ? 'encrypted-file-development' : 'unconfigured',
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
            signal: options.signal || AbortSignal.timeout(15_000),
            headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` }
        });
        if (!response.ok) throw new Error('Drive API request failed');
        return response;
    } catch {
        const error = new Error('The encrypted Drive token vault is unavailable. Verify the service-account credentials, enable the Drive API, and grant it access to the vault file only; do not share the root folder.');
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

async function readSupabaseToken() {
    const { data, error } = await getSupabaseClient()
        .from('drive_oauth_tokens')
        .select('encrypted_payload')
        .eq('provider', TOKEN_PROVIDER)
        .maybeSingle();
    if (error) throw error;
    return data ? decryptToken(data.encrypted_payload) : null;
}

async function writeSupabaseToken(envelope) {
    const { error } = await getSupabaseClient()
        .from('drive_oauth_tokens')
        .upsert({ provider: TOKEN_PROVIDER, encrypted_payload: envelope, updated_at: new Date().toISOString() }, { onConflict: 'provider' });
    if (error) throw error;
}

async function deleteSupabaseToken() {
    const { error } = await getSupabaseClient()
        .from('drive_oauth_tokens')
        .delete()
        .eq('provider', TOKEN_PROVIDER);
    if (error) throw error;
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
        if (isSupabaseConfigured()) return await readSupabaseToken();
        if (isDriveVaultConfigured()) return await readDriveVaultToken();
        if (isRenderEnvironment() || process.env.NODE_ENV === 'production') {
            const error = new Error('Configure Supabase token storage before connecting Google Drive in production.');
            error.code = 'DRIVE_TOKEN_STORAGE_NOT_CONFIGURED';
            throw error;
        }
        const envelope = JSON.parse(await readFile(getTokenFilePath(), 'utf8'));
        return decryptToken(envelope);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'MISSING_DRIVE_TOKEN_ENCRYPTION_KEY' || error.code === 'DRIVE_TOKEN_STORAGE_FAILED') throw error;
        const message = isDriveVaultConfigured()
            ? 'The encrypted Drive token vault could not be read. Verify GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY is unchanged and the service account can access the vault file.'
            : 'The saved Google Drive authorization could not be read. Check configured storage access or the token encryption key, then reconnect if needed.';
        const storageError = new Error(message);
        storageError.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        throw storageError;
    }
}

export async function storeGoogleDriveToken(token) {
    const envelope = encryptToken(token);
    try {
        if (isSupabaseConfigured()) {
            await writeSupabaseToken(envelope);
            return;
        }
        if (isDriveVaultConfigured()) {
            await writeDriveVaultToken(envelope, token.access_token);
            return;
        }
        if (isRenderEnvironment() || process.env.NODE_ENV === 'production') {
            const error = new Error('Configure Supabase token storage before connecting Google Drive in production.');
            error.code = 'DRIVE_TOKEN_STORAGE_NOT_CONFIGURED';
            throw error;
        }
        const tokenFilePath = getTokenFilePath();
        await mkdir(path.dirname(tokenFilePath), { recursive: true });
        const temporaryPath = `${tokenFilePath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(envelope), { mode: 0o600 });
        await rename(temporaryPath, tokenFilePath);
    } catch (error) {
        if (error.code === 'MISSING_DRIVE_TOKEN_ENCRYPTION_KEY' || error.code === 'DRIVE_TOKEN_STORAGE_FAILED') throw error;
        const message = isDriveVaultConfigured()
            ? 'The encrypted Drive token vault could not be written. Verify the service-account credentials and its direct writer access to the vault file; do not share the root folder.'
            : 'The Google Drive authorization could not be saved. Check configured storage access.';
        const storageError = new Error(message);
        storageError.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        storageError.cause = error;
        throw storageError;
    }
}

export async function clearStoredGoogleDriveToken() {
    if (isSupabaseConfigured()) {
        await deleteSupabaseToken();
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