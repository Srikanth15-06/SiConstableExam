import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

let cachedAccessToken;
let tokenExpiresAt = 0;
let storedTokenCache;
let storedTokenCacheLoaded = false;
const SUPPORTED_NOTE_TYPES = new Set([
    'application/pdf',
    'application/vnd.google-apps.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/webp'
]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

const getRootFolderId = () => (process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || process.env.ROOT_FOLDER_ID || '').trim();
const normalizeFolderName = (name) => String(name || '').normalize('NFKC').trim().toLocaleLowerCase();

export class GoogleDriveError extends Error {
    constructor(code, message, diagnostics = {}) {
        super(message);
        this.name = 'GoogleDriveError';
        this.provider = 'Google Drive';
        this.code = code;
        this.diagnostics = diagnostics;
    }
}

export function validateGoogleDriveConfig() {
    const rootFolderId = getRootFolderId();
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();
    let tokenEncryptionKeyConfigured = false;
    try {
        getTokenEncryptionKey();
        tokenEncryptionKeyConfigured = true;
    } catch {
        tokenEncryptionKeyConfigured = false;
    }
    const configured = Boolean(clientId && clientSecret && redirectUri && rootFolderId && tokenEncryptionKeyConfigured);
    return {
        configured,
        clientIdConfigured: Boolean(clientId),
        clientSecretConfigured: Boolean(clientSecret),
        redirectUriConfigured: Boolean(redirectUri),
        tokenEncryptionKeyConfigured,
        rootFolderConfigured: Boolean(rootFolderId),
        connected: Boolean(storedTokenCache?.refresh_token || process.env.GOOGLE_DRIVE_TOKEN)
    };
}

function getConfigurationError() {
    const config = validateGoogleDriveConfig();
    if (!config.clientIdConfigured || !config.clientSecretConfigured || !config.redirectUriConfigured) {
        return new GoogleDriveError('MISSING_GOOGLE_OAUTH_CONFIG', 'Google Drive OAuth credentials are not configured.');
    }
    if (!config.tokenEncryptionKeyConfigured) {
        return new GoogleDriveError('MISSING_DRIVE_TOKEN_ENCRYPTION_KEY', 'Google Drive token encryption is not configured.');
    }
    if (!config.rootFolderConfigured) {
        return new GoogleDriveError('MISSING_ROOT_FOLDER', 'Google Drive notes folder is not configured.');
    }
    return null;
}

function buildAuthUrl(state) {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        scope: 'https://www.googleapis.com/auth/drive',
        state,
        include_granted_scopes: 'true'
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function getTokenEncryptionKey() {
    const encodedKey = (process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY || '').trim();
    const key = /^[a-f\d]{64}$/i.test(encodedKey)
        ? Buffer.from(encodedKey, 'hex')
        : Buffer.from(encodedKey, 'base64');
    if (key.length !== 32) {
        throw new GoogleDriveError('MISSING_DRIVE_TOKEN_ENCRYPTION_KEY', 'Set GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY to a 32-byte base64 or 64-character hex key.');
    }
    return key;
}

function getTokenFilePath() {
    return path.resolve(process.cwd(), process.env.GOOGLE_DRIVE_TOKEN_FILE || '.data/google-drive-token.enc');
}

function getOAuthClientConfig() {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();
    if (!clientId || !clientSecret || !redirectUri) {
        throw new GoogleDriveError('MISSING_GOOGLE_OAUTH_CONFIG', 'Google Drive OAuth credentials are not configured.');
    }
    return { clientId, clientSecret, redirectUri };
}

async function getStoredToken() {
    if (process.env.GOOGLE_DRIVE_TOKEN) {
        try {
            return JSON.parse(process.env.GOOGLE_DRIVE_TOKEN);
        } catch {
            throw new GoogleDriveError('DRIVE_TOKEN_STORAGE_FAILED', 'The configured Google Drive token is not valid JSON.');
        }
    }
    if (storedTokenCacheLoaded) return storedTokenCache;
    const tokenFilePath = getTokenFilePath();
    try {
        const envelope = JSON.parse(await readFile(tokenFilePath, 'utf8'));
        const decipher = createDecipheriv('aes-256-gcm', getTokenEncryptionKey(), Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(envelope.data, 'base64')),
            decipher.final()
        ]).toString('utf8');
        storedTokenCache = JSON.parse(decrypted);
        storedTokenCacheLoaded = true;
        return storedTokenCache;
    } catch (error) {
        if (error.code === 'ENOENT') {
            storedTokenCacheLoaded = true;
            storedTokenCache = null;
            return null;
        }
        if (error instanceof GoogleDriveError) throw error;
        throw new GoogleDriveError('DRIVE_TOKEN_STORAGE_FAILED', 'The saved Google Drive authorization could not be read. Check the token encryption key and reconnect if needed.');
    }
}

async function storeToken(token) {
    const existingToken = await getStoredToken();
    const refreshToken = token?.refresh_token || existingToken?.refresh_token;
    if (!token || !refreshToken) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google did not return a refresh token. Revoke this app’s Drive access in your Google Account and reconnect.');
    }
    const storedToken = {
        access_token: token.access_token,
        refresh_token: refreshToken,
        expires_in: token.expires_in,
        scope: token.scope,
        token_type: token.token_type,
        expiry: Date.now() + (Number(token.expires_in || 3600) * 1000)
    };
    const key = getTokenEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(storedToken), 'utf8'), cipher.final()]);
    const tokenFilePath = getTokenFilePath();
    const directory = path.dirname(tokenFilePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${tokenFilePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64')
    }), { mode: 0o600 });
    await rename(temporaryPath, tokenFilePath);
    storedTokenCache = storedToken;
    storedTokenCacheLoaded = true;
}

async function refreshAccessToken() {
    const token = await getStoredToken();
    if (!token?.refresh_token) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive is not connected. Sign in with Google to authorize access to your Drive notes library.');
    }
    const { clientId, clientSecret, redirectUri } = getOAuthClientConfig();
    try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: token.refresh_token,
                grant_type: 'refresh_token',
                redirect_uri: redirectUri
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.access_token) {
            throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive access token refresh failed. Reconnect the Google account to continue.', {
                stage: 'oauth-token',
                failure: data.error || 'token-rejected',
                httpStatus: response.status
            });
        }
        const refreshedToken = {
            ...token,
            access_token: data.access_token,
            expires_in: data.expires_in || 3600,
            scope: data.scope || token.scope,
            token_type: data.token_type || token.token_type || 'Bearer',
            expiry: Date.now() + (Number(data.expires_in || 3600) * 1000)
        };
        await storeToken({ ...data, refresh_token: token.refresh_token });
        cachedAccessToken = refreshedToken.access_token;
        tokenExpiresAt = refreshedToken.expiry;
        return refreshedToken.access_token;
    } catch (error) {
        if (error instanceof GoogleDriveError) throw error;
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google authentication service is temporarily unavailable.', { stage: 'oauth-token', failure: 'network' });
    }
}

async function getAccessToken() {
    if (cachedAccessToken && tokenExpiresAt > Date.now() + 60_000) return cachedAccessToken;
    const token = await getStoredToken();
    if (!token?.refresh_token) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive is not connected. Sign in with Google to authorize access to your Drive notes library.');
    }
    if ((token.expiry || 0) <= Date.now() + 60_000) {
        return refreshAccessToken();
    }
    cachedAccessToken = token.access_token;
    tokenExpiresAt = Number(token.expiry || Date.now() + 3600_000);
    return cachedAccessToken;
}

export async function buildGoogleDriveAuthUrl(state) {
    if (!state) throw new GoogleDriveError('INVALID_REQUEST', 'OAuth state is required.');
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    return buildAuthUrl(state);
}

export async function exchangeGoogleDriveCode(code) {
    const { clientId, clientSecret, redirectUri } = getOAuthClientConfig();
    let response;
    try {
        response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });
    } catch {
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google authentication service is temporarily unavailable.', { stage: 'oauth-exchange', failure: 'network' });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive authorization failed. Please try connecting again.', {
            stage: 'oauth-exchange',
            failure: data.error || 'token-rejected',
            httpStatus: response.status
        });
    }
    await storeToken(data);
    cachedAccessToken = data.access_token;
    tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    process.env.GOOGLE_DRIVE_CONNECTED = 'true';
    return { connected: true, expiresIn: Number(data.expires_in || 3600) };
}

export async function clearGoogleDriveToken() {
    cachedAccessToken = undefined;
    tokenExpiresAt = 0;
    storedTokenCache = null;
    storedTokenCacheLoaded = true;
    delete process.env.GOOGLE_DRIVE_TOKEN;
    process.env.GOOGLE_DRIVE_CONNECTED = 'false';
    try {
        await unlink(getTokenFilePath());
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

function withSharedDriveOptions(url) {
    if (process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim()) {
        url.searchParams.set('corpora', 'drive');
        url.searchParams.set('driveId', process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID.trim());
        url.searchParams.set('includeItemsFromAllDrives', 'true');
        url.searchParams.set('supportsAllDrives', 'true');
    }
    return url;
}

function classifyDriveResponse(response, data, writeOperation = false) {
    const reasons = (data?.error?.errors || []).map((item) => item.reason || '').join(' ');
    const providerMessage = String(data?.error?.message || '');
    const failureReason = reasons || providerMessage || `http-${response.status}`;
    if (response.status === 401) {
        return new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive authentication failed. Please reconnect your Google account.', { stage: 'drive-api', httpStatus: 401 });
    }
    if (response.status === 404) {
        return new GoogleDriveError('DRIVE_FOLDER_NOT_FOUND', 'The configured Google Drive notes folder was not found.', { stage: 'drive-api', httpStatus: 404 });
    }
    if (response.status === 403 && /storageQuotaExceeded|storage quota|quota exceeded/i.test(`${reasons} ${providerMessage}`)) {
        return new GoogleDriveError('DRIVE_QUOTA_EXCEEDED', 'Google Drive storage quota has been reached. Free up space in the Drive account or switch to a Drive account with available storage before uploading files.', {
            stage: 'drive-api',
            httpStatus: 403,
            failure: 'storageQuotaExceeded'
        });
    }
    if (response.status === 403 && /permission|access denied|insufficient|forbidden/i.test(`${reasons} ${providerMessage}`)) {
        const message = writeOperation
            ? 'The connected Google account needs Editor access to this Drive folder to create folders or upload files.'
            : 'The connected Google account does not have access to the notes folder.';
        return new GoogleDriveError('DRIVE_PERMISSION_DENIED', message, { stage: 'drive-api', httpStatus: 403 });
    }
    return new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive API request failed.', { stage: 'drive-api', httpStatus: response.status, failure: failureReason });
}

async function getRootFolderMetadata(accessToken) {
    const rootFolderId = getRootFolderId();
    if (!rootFolderId) throw new GoogleDriveError('MISSING_ROOT_FOLDER', 'Google Drive notes folder is not configured.');
    return getFolderMetadata(rootFolderId, accessToken);
}

async function getFolderMetadata(folderId, accessToken) {
    const url = withSharedDriveOptions(new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}`));
    url.searchParams.set('fields', 'id,name,mimeType');
    let response;
    try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch {
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive is temporarily unavailable.', { stage: 'drive-folder-metadata', failure: 'network' });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw classifyDriveResponse(response, data);
    if (data.mimeType !== 'application/vnd.google-apps.folder') {
        throw new GoogleDriveError('DRIVE_FOLDER_NOT_FOUND', 'The requested Google Drive item is not a folder.');
    }
    return data;
}

export async function testGoogleDriveConnection() {
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    const accessToken = await getAccessToken();
    await getRootFolderMetadata(accessToken);
    process.env.GOOGLE_DRIVE_CONNECTED = 'true';
    return { folderAccessible: true };
}

export async function getGoogleDriveStatus() {
    const config = validateGoogleDriveConfig();
    const rootFolderId = getRootFolderId();
    const checks = {
        oauth: config.clientIdConfigured && config.clientSecretConfigured && config.redirectUriConfigured,
        rootFolder: config.rootFolderConfigured,
        driveApi: false,
        folderAccess: false
    };
    const configurationError = getConfigurationError();
    if (configurationError) {
        return {
            success: false,
            provider: 'googleDrive',
            configured: false,
            available: false,
            rootFolderId: rootFolderId || null,
            checks,
            code: configurationError.code
        };
    }

    const hasStoredToken = Boolean((await getStoredToken())?.refresh_token);
    if (!hasStoredToken) {
        return {
            success: false,
            provider: 'googleDrive',
            configured: true,
            available: false,
            rootFolderId,
            checks,
            code: 'DRIVE_AUTH_FAILED',
            diagnostics: { authRequired: true }
        };
    }

    try {
        const accessToken = await getAccessToken();
        await getRootFolderMetadata(accessToken);
        checks.driveApi = true;
        checks.folderAccess = true;
        process.env.GOOGLE_DRIVE_CONNECTED = 'true';
        return { success: true, provider: 'googleDrive', configured: true, available: true, rootFolderId, checks };
    } catch (error) {
        if (error.code === 'DRIVE_PERMISSION_DENIED' || error.code === 'DRIVE_FOLDER_NOT_FOUND') checks.driveApi = true;
        return {
            success: false,
            provider: 'googleDrive',
            configured: true,
            available: false,
            connected: error.code !== 'DRIVE_AUTH_FAILED',
            rootFolderId,
            checks,
            code: error.code || 'DRIVE_API_FAILED',
            diagnostics: error.diagnostics || {}
        };
    }
}

async function listChildren(parentId, accessToken) {
    const query = `'${parentId.replace(/'/g, "\\'")}' in parents and trashed = false`;
    const files = [];
    let pageToken;
    do {
        const url = withSharedDriveOptions(new URL('https://www.googleapis.com/drive/v3/files'));
        url.searchParams.set('q', query);
        url.searchParams.set('pageSize', '1000');
        url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,webViewLink,webContentLink,thumbnailLink,size,modifiedTime)');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        let response;
        try {
            response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        } catch {
            throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive is temporarily unavailable.');
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw classifyDriveResponse(response, data);
        files.push(...(data.files || []));
        pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
}

async function createFolder(parentId, name, accessToken) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('fields', 'id,name,mimeType');
    if (process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim()) url.searchParams.set('supportsAllDrives', 'true');
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME_TYPE, parents: [parentId] })
        });
    } catch {
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive folder creation failed due to a network error.', { stage: 'create-folder', failure: 'network' });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw classifyDriveResponse(response, data, true);
    return data;
}

async function findOrCreateFolder(parentId, name, children, accessToken) {
    const existing = children.find((item) => item.mimeType === DRIVE_FOLDER_MIME_TYPE && normalizeFolderName(item.name) === normalizeFolderName(name));
    if (existing) return { folder: existing, created: false };
    const folder = await createFolder(parentId, name, accessToken);
    children.push(folder);
    return { folder, created: true };
}

export async function provisionSubjectTopicFolders(subjects) {
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    if (!Array.isArray(subjects) || !subjects.length || subjects.length > 100) {
        throw new GoogleDriveError('INVALID_REQUEST', 'Provide between 1 and 100 subject folders.');
    }
    let topicCount = 0;
    for (const subject of subjects) {
        if (!subject || typeof subject.name !== 'string' || !subject.name.trim() || !Array.isArray(subject.topics)) {
            throw new GoogleDriveError('INVALID_REQUEST', 'Each subject must include a name and topic list.');
        }
        if (subject.topics.some((topic) => typeof topic !== 'string' || !topic.trim())) {
            throw new GoogleDriveError('INVALID_REQUEST', `Subject ${subject.name} contains an invalid topic name.`);
        }
        topicCount += subject.topics.length;
    }
    if (topicCount > 1000) throw new GoogleDriveError('INVALID_REQUEST', 'The topic folder manifest exceeds the allowed limit.');

    const accessToken = await getAccessToken();
    const root = await getRootFolderMetadata(accessToken);
    const rootChildren = await listChildren(root.id, accessToken);
    let createdSubjects = 0;
    let createdTopics = 0;

    for (const subject of subjects) {
        const subjectResult = await findOrCreateFolder(root.id, subject.name.trim(), rootChildren, accessToken);
        if (subjectResult.created) createdSubjects += 1;
        const subjectChildren = await listChildren(subjectResult.folder.id, accessToken);
        for (const topicName of subject.topics) {
            const topicResult = await findOrCreateFolder(subjectResult.folder.id, topicName.trim(), subjectChildren, accessToken);
            if (topicResult.created) createdTopics += 1;
        }
    }
    process.env.GOOGLE_DRIVE_CONNECTED = 'true';
    return { subjectsProcessed: subjects.length, topicsProcessed: topicCount, createdSubjects, createdTopics };
}

async function assertTopicFolder(folderId, subjectFolderId, accessToken) {
    const root = await getRootFolderMetadata(accessToken);
    const subjectChildren = await listChildren(root.id, accessToken);
    const subjectFolder = subjectChildren.find((item) => item.id === subjectFolderId && item.mimeType === DRIVE_FOLDER_MIME_TYPE);
    if (!subjectFolder) throw new GoogleDriveError('DRIVE_FOLDER_NOT_FOUND', 'The selected subject folder is not a direct child of the configured root.');
    const topicChildren = await listChildren(subjectFolderId, accessToken);
    const topicFolder = topicChildren.find((item) => item.id === folderId && item.mimeType === DRIVE_FOLDER_MIME_TYPE);
    if (!topicFolder) throw new GoogleDriveError('DRIVE_FOLDER_NOT_FOUND', 'Uploads are allowed only inside a topic folder belonging to the selected subject.');
    return topicFolder;
}

export async function uploadTopicFile(folderId, subjectFolderId, fileName, mimeType, content) {
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    const safeName = String(fileName || '').trim().replace(/[\\/\0]/g, '_');
    const normalizedMimeType = String(mimeType || '').trim().toLocaleLowerCase();
    if (!safeName || safeName.length > 240) throw new GoogleDriveError('INVALID_REQUEST', 'Choose a valid file name.');
    if (!SUPPORTED_NOTE_TYPES.has(normalizedMimeType)) throw new GoogleDriveError('UNSUPPORTED_FILE_TYPE', 'Upload PDF, DOC/DOCX, TXT, PNG, JPG/JPEG, or WebP files only.');
    if (!Buffer.isBuffer(content) || !content.length) throw new GoogleDriveError('INVALID_REQUEST', 'The uploaded file is empty.');
    if (content.length > MAX_UPLOAD_BYTES) throw new GoogleDriveError('FILE_TOO_LARGE', 'Files must be 20 MB or smaller.');

    const accessToken = await getAccessToken();
    const topicFolder = await assertTopicFolder(String(folderId || '').trim(), String(subjectFolderId || '').trim(), accessToken);
    const boundary = `drive-upload-${randomUUID()}`;
    const metadata = JSON.stringify({ name: safeName, mimeType: normalizedMimeType, parents: [topicFolder.id] });
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${normalizedMimeType}\r\n\r\n`),
        content,
        Buffer.from(`\r\n--${boundary}--`)
    ]);
    const url = new URL('https://www.googleapis.com/upload/drive/v3/files');
    url.searchParams.set('uploadType', 'multipart');
    url.searchParams.set('fields', 'id,name,mimeType,webViewLink,webContentLink,thumbnailLink,size,modifiedTime');
    if (process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim()) url.searchParams.set('supportsAllDrives', 'true');

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body
        });
    } catch {
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive upload failed due to a network error.', { stage: 'upload-file', failure: 'network' });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw classifyDriveResponse(response, data, true);
    process.env.GOOGLE_DRIVE_CONNECTED = 'true';
    return {
        ...data,
        type: normalizedMimeType.startsWith('image/') ? 'image' : 'file'
    };
}

export async function listDriveFolderContents(folderId) {
    const requestedFolderId = String(folderId || '').trim();
    if (!requestedFolderId) throw new GoogleDriveError('INVALID_REQUEST', 'A Google Drive folder ID is required.');
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    const accessToken = await getAccessToken();
    const folder = requestedFolderId === getRootFolderId()
        ? await getRootFolderMetadata(accessToken)
        : await getFolderMetadata(requestedFolderId, accessToken);
    const children = await listChildren(folder.id, accessToken);
    const folders = [];
    const files = [];

    for (const item of children) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
            folders.push({ ...item, type: 'folder' });
        } else if (SUPPORTED_NOTE_TYPES.has(item.mimeType)) {
            files.push({ ...item, type: item.mimeType.startsWith('image/') ? 'image' : 'file' });
        }
    }
    process.env.GOOGLE_DRIVE_CONNECTED = 'true';
    return {
        folder: { id: folder.id, name: folder.name, mimeType: folder.mimeType },
        folders,
        files
    };
}

export async function getTopicFileContent(fileId, topicFolderId, subjectFolderId) {
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    const accessToken = await getAccessToken();
    const topicFolder = await assertTopicFolder(
        String(topicFolderId || '').trim(),
        String(subjectFolderId || '').trim(),
        accessToken
    );
    const file = (await listChildren(topicFolder.id, accessToken)).find((item) => item.id === String(fileId || '').trim());
    if (!file || !SUPPORTED_NOTE_TYPES.has(file.mimeType)) {
        throw new GoogleDriveError('DRIVE_FILE_NOT_FOUND', 'The requested file is not available in this topic folder.');
    }

    const isGoogleDocument = file.mimeType === 'application/vnd.google-apps.document';
    const url = isGoogleDocument
        ? new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`)
        : new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
    if (isGoogleDocument) url.searchParams.set('mimeType', 'application/pdf');
    else url.searchParams.set('alt', 'media');

    let response;
    try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch {
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive file preview failed due to a network error.', { stage: 'preview-file', failure: 'network' });
    }
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw classifyDriveResponse(response, data);
    }

    const mimeType = isGoogleDocument
        ? 'application/pdf'
        : (response.headers.get('content-type') || file.mimeType).split(';')[0].trim();
    const name = isGoogleDocument && !/\.pdf$/i.test(file.name) ? `${file.name}.pdf` : file.name;
    return { name, mimeType, content: Buffer.from(await response.arrayBuffer()) };
}

export { buildGoogleDriveAuthUrl as getGoogleDriveAuthUrl };
