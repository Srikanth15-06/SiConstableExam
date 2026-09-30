import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { clearStoredGoogleDriveToken, getGoogleDriveTokenStorageStatus, getStoredGoogleDriveToken, storeGoogleDriveToken } from './drive-token-store.mjs';

let cachedAccessToken;
let tokenExpiresAt = 0;
let storedTokenCache;
let storedTokenCacheLoaded = false;
let accessTokenRefresh;
const SUPPORTED_NOTE_TYPES = new Set([
    'application/pdf',
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/webp'
]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const UPLOAD_MIME_BY_EXTENSION = Object.freeze({
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp'
});
const GOOGLE_WORKSPACE_EXPORT_TYPES = new Map([
    ['application/vnd.google-apps.document', 'application/pdf'],
    ['application/vnd.google-apps.spreadsheet', 'application/pdf'],
    ['application/vnd.google-apps.presentation', 'application/pdf']
]);

const getRootFolderId = () => (process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || process.env.ROOT_FOLDER_ID || '').trim();
const normalizeFolderName = (name) => String(name || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

export function getGoogleDriveRootFolderId() {
    return getRootFolderId();
}

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
    const tokenStorage = getGoogleDriveTokenStorageStatus();
    const configured = Boolean(clientId && clientSecret && redirectUri && rootFolderId && tokenStorage.encryptionKeyConfigured && tokenStorage.configured);
    return {
        configured,
        clientIdConfigured: Boolean(clientId),
        clientSecretConfigured: Boolean(clientSecret),
        redirectUriConfigured: Boolean(redirectUri),
        tokenEncryptionKeyConfigured: tokenStorage.encryptionKeyConfigured,
        tokenStorageConfigured: tokenStorage.configured,
        tokenStorageDurable: tokenStorage.durable,
        tokenStorageProvider: tokenStorage.provider,
        adminAuthConfigured: Boolean(process.env.GOOGLE_DRIVE_ADMIN_KEY?.trim()),
        rootFolderConfigured: Boolean(rootFolderId),
        connected: Boolean(storedTokenCache?.refresh_token || (process.env.NODE_ENV !== 'production' && process.env.GOOGLE_DRIVE_TOKEN))
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
    if (!config.tokenStorageConfigured) {
        const message = process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID
            ? 'Configure Supabase and GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY for durable Google Drive token storage. The Notes Library remains separate from account data.'
            : 'Configure Supabase for durable Google Drive token storage, or reconnect using local development settings.';
        return new GoogleDriveError('DRIVE_TOKEN_STORAGE_NOT_CONFIGURED', message);
    }
    return null;
}

function getOAuthClientConfig() {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();
    if (!clientId || !clientSecret || !redirectUri) {
        throw new GoogleDriveError('MISSING_GOOGLE_OAUTH_CONFIG', 'Google Drive OAuth credentials are not configured.');
    }
    if (process.env.NODE_ENV === 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(redirectUri)) {
        throw new GoogleDriveError('GOOGLE_REDIRECT_URI_MISMATCH', 'Production Google OAuth must use the configured HTTPS Render callback URL.');
    }
    return { clientId, clientSecret, redirectUri };
}

function createOAuth2Client() {
    const { clientId, clientSecret, redirectUri } = getOAuthClientConfig();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getStoredToken() {
    if (process.env.GOOGLE_DRIVE_TOKEN && process.env.NODE_ENV !== 'production') {
        try {
            return JSON.parse(process.env.GOOGLE_DRIVE_TOKEN);
        } catch {
            throw new GoogleDriveError('DRIVE_TOKEN_STORAGE_FAILED', 'The configured Google Drive token is not valid JSON.');
        }
    }
    if (storedTokenCacheLoaded) return storedTokenCache;
    try {
        storedTokenCache = await getStoredGoogleDriveToken();
    } catch (error) {
        throw new GoogleDriveError(error.code || 'DRIVE_TOKEN_STORAGE_FAILED', error.message || 'The saved Google Drive authorization could not be accessed.');
    }
    storedTokenCacheLoaded = true;
    return storedTokenCache;
}

async function storeToken(token) {
    const existingToken = await getStoredToken();
    const refreshToken = token?.refresh_token || existingToken?.refresh_token;
    if (!token || !refreshToken) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google did not return a refresh token. Revoke this app’s Drive access in your Google Account and reconnect.');
    }
    const expiresIn = Number(token.expires_in || 3600);
    const storedToken = {
        ...existingToken,
        ...token,
        refresh_token: refreshToken,
        expiry: Number(token.expiry || token.expiry_date || (Date.now() + expiresIn * 1000))
    };
    try {
        await storeGoogleDriveToken(storedToken);
    } catch (error) {
        throw new GoogleDriveError(error.code || 'DRIVE_TOKEN_STORAGE_FAILED', error.message || 'The Google Drive authorization could not be saved.');
    }
    storedTokenCache = storedToken;
    storedTokenCacheLoaded = true;
    return storedToken;
}

function classifyOAuthError(error, stage) {
    const oauthCode = String(error?.response?.data?.error || error?.code || 'oauth-error').split(/[\s:]/, 1)[0];
    const httpStatus = error?.response?.status || error?.status;
    if ((!error?.response && /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)/i.test(oauthCode)) || httpStatus >= 500) {
        return new GoogleDriveError('DRIVE_API_FAILED', 'Google authentication service is temporarily unavailable.', { stage, failure: 'network', httpStatus });
    }
    const errors = {
        invalid_grant: ['DRIVE_AUTH_REVOKED', 'Google Drive authorization expired or was revoked. Reconnect the Google account.'],
        unauthorized_client: ['GOOGLE_UNAUTHORIZED_CLIENT', 'The Google OAuth client is not authorized for this application.'],
        invalid_client: ['GOOGLE_INVALID_CLIENT', 'The configured Google OAuth client ID or secret is invalid.'],
        redirect_uri_mismatch: ['GOOGLE_REDIRECT_URI_MISMATCH', 'The Google OAuth redirect URI does not match the URI configured in Google Cloud.']
    };
    const [code, message] = errors[oauthCode] || ['DRIVE_AUTH_FAILED', 'Google Drive authorization failed. Reconnect the Google account.'];
    return new GoogleDriveError(code, message, { stage, oauthError: oauthCode, httpStatus });
}

async function refreshAccessToken() {
    if (accessTokenRefresh) return accessTokenRefresh;
    accessTokenRefresh = refreshStoredAccessToken();
    try {
        return await accessTokenRefresh;
    } finally {
        accessTokenRefresh = null;
    }
}

async function refreshStoredAccessToken() {
    const token = await getStoredToken();
    if (!token?.refresh_token) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive is not connected. Sign in with Google to authorize access to your Drive notes library.');
    }
    const oauthClient = createOAuth2Client();
    oauthClient.setCredentials(token);
    try {
        await oauthClient.refreshAccessToken();
        const data = oauthClient.credentials;
        if (!data.access_token) throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive access token refresh failed. Reconnect the Google account to continue.');
        const refreshedToken = {
            ...token,
            ...data,
            refresh_token: data.refresh_token || token.refresh_token,
            expiry: Number(data.expiry_date || (Date.now() + Number(data.expires_in || 3600) * 1000))
        };
        await storeToken(refreshedToken);
        cachedAccessToken = refreshedToken.access_token;
        tokenExpiresAt = refreshedToken.expiry;
        return refreshedToken.access_token;
    } catch (error) {
        if (error instanceof GoogleDriveError) throw error;
        throw classifyOAuthError(error, 'oauth-refresh');
    }
}

async function getAccessToken() {
    if (cachedAccessToken && tokenExpiresAt > Date.now() + 60_000) return cachedAccessToken;
    const token = await getStoredToken();
    if (!token?.refresh_token) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive is not connected. Sign in with Google to authorize access to your Drive notes library.');
    }
    if (!token.access_token || (token.expiry || 0) <= Date.now() + 60_000) {
        return refreshAccessToken();
    }
    cachedAccessToken = token.access_token;
    tokenExpiresAt = Number(token.expiry || Date.now() + 3600_000);
    return cachedAccessToken;
}

async function fetchDrive(url, options = {}) {
    let accessToken = await getAccessToken();
    const request = (token) => fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(20_000),
        headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
    });
    let response = await request(accessToken);
    if (response.status !== 401) return response;

    cachedAccessToken = undefined;
    tokenExpiresAt = 0;
    accessToken = await refreshAccessToken();
    return request(accessToken);
}

export async function fetchAuthorizedGoogleDriveApi(url, options = {}) {
    const requestUrl = url instanceof URL ? url : new URL(String(url));
    const response = await fetchDrive(requestUrl, options);
    if (response.ok) return response;
    const data = await response.json().catch(() => ({}));
    throw classifyDriveResponse(response, data, Boolean(options.method && options.method !== 'GET'));
}

export async function buildGoogleDriveAuthUrl(state) {
    if (!state) throw new GoogleDriveError('INVALID_REQUEST', 'OAuth state is required.');
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    return createOAuth2Client().generateAuthUrl({
        access_type: 'offline',
        include_granted_scopes: true,
        prompt: 'consent',
        scope: [DRIVE_SCOPE],
        state
    });
}

export async function exchangeGoogleDriveCode(code) {
    if (!String(code || '').trim()) throw new GoogleDriveError('INVALID_REQUEST', 'Google authorization code is required.');
    const oauthClient = createOAuth2Client();
    let tokens;
    try {
        ({ tokens } = await oauthClient.getToken(String(code).trim()));
    } catch (error) {
        throw classifyOAuthError(error, 'oauth-exchange');
    }
    if (!tokens?.access_token) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google did not return an access token. Please connect again.');
    }
    const existingToken = await getStoredToken();
    if (!tokens.refresh_token && !existingToken?.refresh_token) {
        throw new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google did not return a refresh token. Revoke this app’s Drive access in your Google Account and reconnect.');
    }
    const storedToken = await storeToken({
        ...tokens,
        refresh_token: tokens.refresh_token || existingToken.refresh_token,
        expiry: Number(tokens.expiry_date || (Date.now() + Number(tokens.expires_in || 3600) * 1000))
    });
    cachedAccessToken = storedToken.access_token;
    tokenExpiresAt = storedToken.expiry;
    process.env.GOOGLE_DRIVE_CONNECTED = 'true';
    return { connected: true, expiresIn: Number(tokens.expires_in || 3600) };
}

export async function clearGoogleDriveToken() {
    cachedAccessToken = undefined;
    tokenExpiresAt = 0;
    storedTokenCache = null;
    storedTokenCacheLoaded = true;
    accessTokenRefresh = null;
    delete process.env.GOOGLE_DRIVE_TOKEN;
    process.env.GOOGLE_DRIVE_CONNECTED = 'false';
    try {
        await clearStoredGoogleDriveToken();
    } catch (error) {
        throw new GoogleDriveError(error.code || 'DRIVE_TOKEN_STORAGE_FAILED', error.message || 'The saved Google Drive authorization could not be removed.');
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
    const providerCode = String(data?.error?.status || data?.error?.code || reasons || `http-${response.status}`);
    if (/accessNotConfigured/i.test(`${providerCode} ${reasons} ${providerMessage}`)) {
        return new GoogleDriveError('DRIVE_API_NOT_ENABLED', 'Google Drive API is not enabled for the configured Google Cloud project.', { stage: 'drive-api', httpStatus: response.status, providerCode: 'accessNotConfigured' });
    }
    if (response.status === 401) {
        return new GoogleDriveError('DRIVE_AUTH_FAILED', 'Google Drive authentication failed. Please reconnect your Google account.', { stage: 'drive-api', httpStatus: 401, providerCode });
    }
    if (response.status === 404) {
        return new GoogleDriveError('DRIVE_FOLDER_NOT_FOUND', 'The requested Google Drive item was not found or is not accessible.', { stage: 'drive-api', httpStatus: 404, providerCode: 'notFound' });
    }
    if (response.status === 412) {
        return new GoogleDriveError('DRIVE_DATA_CONFLICT', 'Google Drive application data changed during this update. Retry the operation.', { stage: 'drive-api', httpStatus: 412, providerCode: 'conditionNotMet' });
    }
    if ((response.status === 403 || response.status === 429) && /rateLimitExceeded|userRateLimitExceeded/i.test(`${providerCode} ${reasons} ${providerMessage}`)) {
        return new GoogleDriveError('DRIVE_RATE_LIMITED', 'Google Drive is receiving too many requests. Wait briefly and try again.', { stage: 'drive-api', httpStatus: response.status, providerCode });
    }
    if (response.status === 403 && /storageQuotaExceeded|storage quota|quota exceeded/i.test(`${providerCode} ${reasons} ${providerMessage}`)) {
        return new GoogleDriveError('DRIVE_QUOTA_EXCEEDED', 'Google Drive storage quota has been reached. Free up space in the Drive account or switch to a Drive account with available storage before uploading files.', {
            stage: 'drive-api',
            httpStatus: 403,
            providerCode: 'storageQuotaExceeded'
        });
    }
    if (response.status === 403 && /permission|access denied|insufficient|forbidden/i.test(`${providerCode} ${reasons} ${providerMessage}`)) {
        const message = writeOperation
            ? 'The connected Google account needs Editor access to this Drive folder to create folders or upload files.'
            : 'The connected Google account does not have access to the notes folder.';
        return new GoogleDriveError('DRIVE_PERMISSION_DENIED', message, { stage: 'drive-api', httpStatus: 403, providerCode });
    }
    const code = response.status === 400 ? 'DRIVE_BAD_REQUEST' : 'DRIVE_API_FAILED';
    const message = response.status === 400 ? 'Google Drive rejected the request. Check the selected file or folder and try again.' : 'Google Drive API request failed.';
    return new GoogleDriveError(code, message, { stage: 'drive-api', httpStatus: response.status, providerCode });
}

async function getRootFolderMetadata(accessToken) {
    const rootFolderId = getRootFolderId();
    if (!rootFolderId) throw new GoogleDriveError('MISSING_ROOT_FOLDER', 'Google Drive notes folder is not configured.');
    return getFolderMetadata(rootFolderId, accessToken);
}

async function getFolderMetadata(folderId, accessToken) {
    const url = withSharedDriveOptions(new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}`));
    url.searchParams.set('fields', 'id,name,mimeType,parents');
    let response;
    try {
        response = await fetchDrive(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (error) {
        if (error instanceof GoogleDriveError) throw error;
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive is temporarily unavailable.', { stage: 'drive-folder-metadata', failure: 'network' });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw classifyDriveResponse(response, data);
    if (data.mimeType !== 'application/vnd.google-apps.folder') {
        throw new GoogleDriveError('DRIVE_FOLDER_NOT_FOUND', 'The requested Google Drive item is not a folder.');
    }
    return data;
}

async function assertFolderWithinRoot(folderId, accessToken) {
    const rootFolderId = getRootFolderId();
    if (!folderId || folderId === rootFolderId) return getRootFolderMetadata(accessToken);
    const requestedFolder = await getFolderMetadata(folderId, accessToken);
    let current = requestedFolder;
    const visited = new Set([current.id]);
    for (let depth = 0; depth < 10; depth += 1) {
        if (current.parents?.includes(rootFolderId)) return requestedFolder;
        const parentId = current.parents?.[0];
        if (!parentId || visited.has(parentId)) break;
        visited.add(parentId);
        current = await getFolderMetadata(parentId, accessToken);
    }
    throw new GoogleDriveError('DRIVE_FOLDER_NOT_FOUND', 'The requested folder is outside the configured Notes Library.');
}

export async function testGoogleDriveConnection() {
    const status = await getGoogleDriveStatus();
    return {
        ...status,
        tests: {
            credentials: status.checks.credentials,
            tokenStorage: status.checks.tokenStorage,
            authentication: status.checks.authentication,
            driveApi: status.checks.driveApi,
            rootFolder: status.checks.rootFolder,
            listFiles: status.checks.listFiles,
            rootFolderName: status.rootFolderName
        }
    };
}

export async function getGoogleDriveStatus() {
    const config = validateGoogleDriveConfig();
    const rootFolderId = getRootFolderId();
    const checks = {
        credentials: config.clientIdConfigured && config.clientSecretConfigured && config.redirectUriConfigured,
        authentication: false,
        oauth: config.clientIdConfigured && config.clientSecretConfigured && config.redirectUriConfigured,
        rootFolder: false,
        listFiles: false,
        driveApi: false,
        folderAccess: false,
        tokenStorage: config.tokenStorageConfigured
    };
    const status = {
        ok: false,
        success: false,
        provider: 'google-drive',
        adminAuthConfigured: config.adminAuthConfigured,
        configured: config.configured,
        available: false,
        authenticated: false,
        connected: false,
        rootFolderConfigured: config.rootFolderConfigured,
        rootFolderAccessible: false,
        rootFolderId: rootFolderId || null,
        rootFolderName: null,
        tokenStorage: {
            configured: config.tokenStorageConfigured,
            durable: config.tokenStorageDurable,
            provider: config.tokenStorageProvider,
            encryptionKeyConfigured: config.tokenEncryptionKeyConfigured,
            available: null
        },
        checks
    };
    const configurationError = getConfigurationError();
    if (configurationError) {
        return {
            ...status,
            message: configurationError.message,
            code: configurationError.code
        };
    }

    let token;
    try {
        token = await getStoredToken();
    } catch (error) {
        checks.tokenStorage = false;
        status.tokenStorage.available = false;
        return { ...status, message: error.message, code: error.code || 'DRIVE_TOKEN_STORAGE_FAILED' };
    }
    checks.tokenStorage = true;
    status.tokenStorage.available = true;
    if (!token?.refresh_token) {
        return { ...status, message: 'Google Drive authorization is required.', code: 'AUTH_REQUIRED' };
    }

    try {
        const accessToken = await getAccessToken();
        checks.authentication = true;
        const root = await getRootFolderMetadata(accessToken);
        checks.driveApi = true;
        checks.rootFolder = true;
        checks.folderAccess = true;
        status.rootFolderName = root.name;
        status.authenticated = true;
        status.connected = true;
        status.rootFolderAccessible = true;
        await listChildren(root.id, accessToken);
        checks.listFiles = true;
        process.env.GOOGLE_DRIVE_CONNECTED = 'true';
        return { ...status, ok: true, success: true, available: true, message: 'Google Drive is connected and ready.' };
    } catch (error) {
        if (error.code === 'DRIVE_PERMISSION_DENIED' || error.code === 'DRIVE_FOLDER_NOT_FOUND') checks.driveApi = true;
        const authFailed = ['DRIVE_AUTH_FAILED', 'DRIVE_AUTH_REVOKED'].includes(error.code);
        status.authenticated = checks.authentication && !authFailed;
        status.connected = status.authenticated;
        status.rootFolderAccessible = checks.rootFolder;
        const code = error.code === 'DRIVE_PERMISSION_DENIED' || error.code === 'DRIVE_FOLDER_NOT_FOUND'
            ? 'FOLDER_ACCESS_FAILED'
            : error.code === 'DRIVE_AUTH_REVOKED' ? 'AUTH_REQUIRED' : (error.code || 'DRIVE_API_FAILED');
        return {
            ...status,
            message: code === 'FOLDER_ACCESS_FAILED'
                ? 'The authorized Google account cannot access the configured Notes Library folder.'
                : error.message || 'Google Drive is temporarily unavailable.',
            code,
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
            response = await fetchDrive(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        } catch (error) {
            if (error instanceof GoogleDriveError) throw error;
            throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive is temporarily unavailable.');
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw classifyDriveResponse(response, data);
        files.push(...(data.files || []));
        pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
}

export async function listDriveTopicFiles(subjectName, topicName) {
    const subject = String(subjectName || '').trim();
    const topic = String(topicName || '').trim();
    if (!subject || !topic) throw new GoogleDriveError('INVALID_REQUEST', 'Choose a subject and topic to view Google Drive notes.');
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;

    const accessToken = await getAccessToken();
    const root = await getRootFolderMetadata(accessToken);
    const rootChildren = await listChildren(root.id, accessToken);
    const subjectFolder = rootChildren.find((item) => item.mimeType === DRIVE_FOLDER_MIME_TYPE && normalizeFolderName(item.name) === normalizeFolderName(subject));
    if (!subjectFolder) {
        throw new GoogleDriveError('SUBJECT_FOLDER_NOT_FOUND', 'No subject folder found in the configured Notes Library.');
    }

    const subjectChildren = await listChildren(subjectFolder.id, accessToken);
    const topicFolder = subjectChildren.find((item) => item.mimeType === DRIVE_FOLDER_MIME_TYPE && normalizeFolderName(item.name) === normalizeFolderName(topic));
    if (!topicFolder) {
        throw new GoogleDriveError('TOPIC_FOLDER_NOT_FOUND', 'No notes folder found for this topic.');
    }

    const files = (await listChildren(topicFolder.id, accessToken))
        .filter((item) => item.mimeType !== DRIVE_FOLDER_MIME_TYPE && SUPPORTED_NOTE_TYPES.has(item.mimeType))
        .map(({ id, name, mimeType, size, modifiedTime, webViewLink, webContentLink }) => ({
            id, name, mimeType, size, modifiedTime, webViewLink, webContentLink
        }));
    process.env.GOOGLE_DRIVE_CONNECTED = 'true';
    return {
        rootFolder: { id: root.id, name: root.name },
        subjectFolder: { id: subjectFolder.id, name: subjectFolder.name },
        topicFolder: { id: topicFolder.id, name: topicFolder.name },
        files
    };
}

async function createFolder(parentId, name, accessToken) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('fields', 'id,name,mimeType');
    if (process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim()) url.searchParams.set('supportsAllDrives', 'true');
    let response;
    try {
        response = await fetchDrive(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME_TYPE, parents: [parentId] })
        });
    } catch (error) {
        if (error instanceof GoogleDriveError) throw error;
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
    const safeName = String(fileName || '').trim().replace(/[\u0000-\u001f\u007f\\/:]/g, '_');
    const normalizedMimeType = String(mimeType || '').trim().toLocaleLowerCase();
    if (!safeName || safeName.length > 240) throw new GoogleDriveError('INVALID_REQUEST', 'Choose a valid file name.');
    const extension = safeName.split('.').at(-1)?.toLocaleLowerCase();
    if (!SUPPORTED_NOTE_TYPES.has(normalizedMimeType) || UPLOAD_MIME_BY_EXTENSION[extension] !== normalizedMimeType) {
        throw new GoogleDriveError('UNSUPPORTED_FILE_TYPE', 'Upload PDF, DOC/DOCX, TXT, PNG, JPG/JPEG, or WebP files with a matching file type.');
    }
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
        response = await fetchDrive(url, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body
        });
    } catch (error) {
        if (error instanceof GoogleDriveError) throw error;
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
    const folder = await assertFolderWithinRoot(requestedFolderId, accessToken);
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

export async function getDriveFileContent(fileId, folderId) {
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    const requestedFileId = String(fileId || '').trim();
    const requestedFolderId = String(folderId || '').trim();
    if (!requestedFileId || !requestedFolderId) throw new GoogleDriveError('INVALID_REQUEST', 'A file ID and Notes Library folder ID are required.');
    const accessToken = await getAccessToken();
    const folder = await assertFolderWithinRoot(requestedFolderId, accessToken);
    const file = (await listChildren(folder.id, accessToken)).find((item) => item.id === requestedFileId && SUPPORTED_NOTE_TYPES.has(item.mimeType));
    if (!file) throw new GoogleDriveError('DRIVE_FILE_NOT_FOUND', 'The requested file is not available in this Notes Library folder.');

    const exportMimeType = GOOGLE_WORKSPACE_EXPORT_TYPES.get(file.mimeType);
    const url = exportMimeType
        ? new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`)
        : new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
    if (exportMimeType) url.searchParams.set('mimeType', exportMimeType);
    else url.searchParams.set('alt', 'media');

    let response;
    try {
        response = await fetchDrive(url);
    } catch (error) {
        if (error instanceof GoogleDriveError) throw error;
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive file preview failed due to a network error.', { stage: 'preview-file', failure: 'network' });
    }
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw classifyDriveResponse(response, data);
    }
    const mimeType = exportMimeType
        ? exportMimeType
        : (response.headers.get('content-type') || file.mimeType).split(';')[0].trim();
    const name = exportMimeType && !/\.pdf$/i.test(file.name) ? `${file.name}.pdf` : file.name;
    return { name, mimeType, content: Buffer.from(await response.arrayBuffer()) };
}

export async function deleteDriveFile(fileId, folderId) {
    const configurationError = getConfigurationError();
    if (configurationError) throw configurationError;
    const requestedFileId = String(fileId || '').trim();
    const requestedFolderId = String(folderId || '').trim();
    if (!requestedFileId || !requestedFolderId) throw new GoogleDriveError('INVALID_REQUEST', 'A file ID and Notes Library folder ID are required.');
    const accessToken = await getAccessToken();
    const folder = await assertFolderWithinRoot(requestedFolderId, accessToken);
    const file = (await listChildren(folder.id, accessToken)).find((item) => item.id === requestedFileId && SUPPORTED_NOTE_TYPES.has(item.mimeType));
    if (!file) throw new GoogleDriveError('DRIVE_FILE_NOT_FOUND', 'The requested file is not available in this Notes Library folder.');

    const url = withSharedDriveOptions(new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`));
    let response;
    try {
        response = await fetchDrive(url, { method: 'DELETE' });
    } catch (error) {
        if (error instanceof GoogleDriveError) throw error;
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive file deletion failed due to a network error.', { stage: 'delete-file', failure: 'network' });
    }
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw classifyDriveResponse(response, data, true);
    }
    return { id: file.id, deleted: true };
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

    const exportMimeType = GOOGLE_WORKSPACE_EXPORT_TYPES.get(file.mimeType);
    const url = exportMimeType
        ? new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`)
        : new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
    if (exportMimeType) url.searchParams.set('mimeType', exportMimeType);
    else url.searchParams.set('alt', 'media');

    let response;
    try {
        response = await fetchDrive(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (error) {
        if (error instanceof GoogleDriveError) throw error;
        throw new GoogleDriveError('DRIVE_API_FAILED', 'Google Drive file preview failed due to a network error.', { stage: 'preview-file', failure: 'network' });
    }
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw classifyDriveResponse(response, data);
    }

    const mimeType = exportMimeType
        ? exportMimeType
        : (response.headers.get('content-type') || file.mimeType).split(';')[0].trim();
    const name = exportMimeType && !/\.pdf$/i.test(file.name) ? `${file.name}.pdf` : file.name;
    return { name, mimeType, content: Buffer.from(await response.arrayBuffer()) };
}

export { buildGoogleDriveAuthUrl as getGoogleDriveAuthUrl };
