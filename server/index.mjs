import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { generateQuestions, generateNotes, generateChatReply, getAiStatus } from './ai-service.mjs';
import { buildGoogleDriveAuthUrl, clearGoogleDriveToken, deleteDriveFile, exchangeGoogleDriveCode, getDriveFileContent, getGoogleDriveRootFolderId, getGoogleDriveStatus, getTopicFileContent, listDriveFolderContents, listDriveTopicFiles, provisionSubjectTopicFolders, testGoogleDriveConnection, uploadTopicFile, validateGoogleDriveConfig } from './google-drive-service.mjs';
import { createAuthenticationRouter, createAuthenticationMiddleware } from './auth-service.mjs';
import { createUserDataRouter } from './user-data-routes.mjs';
import { describeAiFailure, sanitizeApiError } from './provider-manager.mjs';
import { SupabaseDataStore } from './supabase-data-store.mjs';
import { SupabaseSessionStore } from './supabase-session-store.mjs';
import { isSupabaseConfigured } from './supabase-client.mjs';
import { validateProductionEnvironment } from './production-config.mjs';
import { getHealthStatus } from './health-status.mjs';
import { createCandidateDriveUploadRouter } from './drive-upload-routes.mjs';
import { createTopicLearningVideoRouter } from './topic-learning-video-routes.mjs';
import { createSupabaseLearningVideoStore } from './supabase-learning-video-store.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.join(__dirname, '../frontend/dist');

const app = express();
const PORT = Number(process.env.PORT || process.env.AI_SERVER_PORT || 8787);
const isProduction = process.env.NODE_ENV === 'production';
const frontendUrl = process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || (isProduction ? '' : 'http://localhost:5173');
const configuredFrontendOrigins = (process.env.FRONTEND_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
const allowedOrigins = new Set([
    frontendUrl,
    ...configuredFrontendOrigins,
    ...(!isProduction ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [])
].filter(Boolean).map((origin) => new URL(origin).origin));
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : randomBytes(32).toString('hex'));
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DRIVE_ADMIN_COOKIE = 'drive_admin_session';
const DRIVE_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const getDriveAdminKey = () => String(process.env.GOOGLE_DRIVE_ADMIN_KEY || '').trim();
const productionConfigurationIssues = validateProductionEnvironment(process.env);
if (productionConfigurationIssues.length) {
    throw new Error(`Invalid production configuration: ${productionConfigurationIssues.join('; ')}.`);
}

const candidateSessions = new SupabaseSessionStore();
const requireCandidateSession = createAuthenticationMiddleware(candidateSessions);
const candidateDataStore = new SupabaseDataStore();

if (isProduction) app.set('trust proxy', 1);
app.disable('x-powered-by');

function createIpRateLimiter({ limit, windowMs, code, message }) {
    const clients = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
        let bucket = clients.get(clientKey);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            clients.set(clientKey, bucket);
        }
        if (bucket.count >= limit) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
            res.status(429).json({ success: false, code, message });
            return;
        }
        bucket.count += 1;
        res.setHeader('RateLimit-Limit', String(limit));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
        res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
        if (clients.size > 5000) {
            for (const [key, value] of clients) {
                if (value.resetAt <= now) clients.delete(key);
            }
        }
        next();
    };
}

const aiRateLimiter = createIpRateLimiter({
    limit: 20,
    windowMs: 60_000,
    code: 'RATE_LIMITED',
    message: 'Too many AI requests. Wait briefly before trying again.'
});
const questionRateLimiter = createIpRateLimiter({
    limit: 5,
    windowMs: 5 * 60_000,
    code: 'RATE_LIMITED',
    message: 'Too many question sets were requested. Wait a few minutes before trying again.'
});
const adminLoginRateLimiter = createIpRateLimiter({
    limit: 5,
    windowMs: 15 * 60_000,
    code: 'DRIVE_ADMIN_RATE_LIMITED',
    message: 'Too many administrator sign-in attempts. Wait before trying again.'
});
const candidateSignupRateLimiter = createIpRateLimiter({
    limit: 5,
    windowMs: 15 * 60_000,
    code: 'SIGNUP_RATE_LIMITED',
    message: 'Too many signup attempts. Wait before trying again.'
});
const candidateLoginRateLimiter = createIpRateLimiter({
    limit: 5,
    windowMs: 15 * 60_000,
    code: 'LOGIN_RATE_LIMITED',
    message: 'Too many login attempts. Wait before trying again.'
});
const candidateLegacyImportRateLimiter = createIpRateLimiter({
    limit: 3,
    windowMs: 15 * 60_000,
    code: 'LEGACY_IMPORT_RATE_LIMITED',
    message: 'Too many legacy import attempts. Wait before trying again.'
});
const userDataRateLimiter = createIpRateLimiter({
    limit: 120,
    windowMs: 60_000,
    code: 'USER_DATA_RATE_LIMITED',
    message: 'Too many account-data requests. Wait briefly before trying again.'
});
const testSubmitRateLimiter = createIpRateLimiter({
    limit: 30,
    windowMs: 60_000,
    code: 'TEST_SUBMISSION_RATE_LIMITED',
    message: 'Too many test submissions. Wait briefly before trying again.'
});
const driveApiRateLimiter = createIpRateLimiter({
    limit: 120,
    windowMs: 60_000,
    code: 'DRIVE_RATE_LIMITED',
    message: 'Too many Google Drive requests. Wait briefly before trying again.'
});
const candidateDriveUploadRateLimiter = createIpRateLimiter({
    limit: 5,
    windowMs: 60 * 60_000,
    code: 'DRIVE_UPLOAD_RATE_LIMITED',
    message: 'Too many shared notes were uploaded. Try again later.'
});

app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use('/api/drive', driveApiRateLimiter);
app.use('/api', (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        if (res.statusCode >= 400 || durationMs >= 1_000) {
            console.log(JSON.stringify({
                category: 'http',
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs: Math.round(durationMs)
            }));
        }
    });
    next();
});
app.use('/api', createAuthenticationRouter({
    dataStore: candidateDataStore,
    sessions: candidateSessions,
    allowedOrigins,
    secureCookies: isProduction,
    rateLimiters: {
        signup: candidateSignupRateLimiter,
        login: candidateLoginRateLimiter,
        legacyImport: candidateLegacyImportRateLimiter
    }
}));
app.use('/api', createUserDataRouter({
    dataStore: candidateDataStore,
    sessions: candidateSessions,
    allowedOrigins,
    rateLimiters: {
        createTest: questionRateLimiter,
        submitTest: testSubmitRateLimiter,
        userData: userDataRateLimiter
    }
}));

app.use(express.static(frontendDist));

function createSignedToken(purpose, ttl) {
    const payload = `${Date.now() + ttl}.${randomBytes(24).toString('hex')}`;
    const signature = createHmac('sha256', sessionSecret).update(`${purpose}:${payload}`).digest('hex');
    return `${payload}.${signature}`;
}

function isValidSignedToken(value, purpose, ttl) {
    const [expiresAt, nonce, signature, extra] = String(value || '').split('.');
    if (extra || !/^\d+$/.test(expiresAt || '') || !/^[a-f\d]{48}$/i.test(nonce || '') || !/^[a-f\d]{64}$/i.test(signature || '')) return false;
    const expiration = Number(expiresAt);
    if (!Number.isFinite(expiration) || expiration < Date.now() || expiration > Date.now() + ttl + 60_000) return false;
    const expected = createHmac('sha256', sessionSecret).update(`${purpose}:${expiresAt}.${nonce}`).digest();
    const received = Buffer.from(signature, 'hex');
    return expected.length === received.length && timingSafeEqual(expected, received);
}

function createOAuthState() {
    return createSignedToken('drive-oauth-state', OAUTH_STATE_TTL_MS);
}

function isValidOAuthState(state) {
    return isValidSignedToken(state, 'drive-oauth-state', OAUTH_STATE_TTL_MS);
}

function readCookie(req, name) {
    for (const entry of String(req.headers.cookie || '').split(';')) {
        const separator = entry.indexOf('=');
        if (separator >= 0 && entry.slice(0, separator).trim() === name) {
            try {
                return decodeURIComponent(entry.slice(separator + 1).trim());
            } catch {
                return '';
            }
        }
    }
    return '';
}

function isDriveAdminAuthorized(req) {
    return Boolean(getDriveAdminKey() && isValidSignedToken(
        readCookie(req, DRIVE_ADMIN_COOKIE),
        'drive-admin-session',
        DRIVE_ADMIN_SESSION_TTL_MS
    ));
}

function driveAdminFailure(res, code, status, message) {
    res.status(status).json({ success: false, ok: false, provider: 'google-drive', code, message });
}

function requireDriveAdmin(req, res, next) {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(new URL(origin).origin)) {
        driveAdminFailure(res, 'DRIVE_ADMIN_ORIGIN_DENIED', 403, 'This origin cannot manage the Google Drive Notes Library.');
        return;
    }
    if (!getDriveAdminKey()) {
        driveAdminFailure(res, 'DRIVE_ADMIN_AUTH_NOT_CONFIGURED', 503, 'Google Drive administrator access is not configured on the server.');
        return;
    }
    if (!isDriveAdminAuthorized(req)) {
        driveAdminFailure(res, 'DRIVE_ADMIN_AUTH_REQUIRED', 401, 'Administrator access is required to manage the Google Drive Notes Library.');
        return;
    }
    next();
}

app.use('/api', createTopicLearningVideoRouter({
    dataStore: candidateDataStore,
    videoStore: createSupabaseLearningVideoStore(candidateDataStore),
    sessions: candidateSessions,
    allowedOrigins,
    rateLimiter: userDataRateLimiter
}));

app.post('/api/drive/admin/session', adminLoginRateLimiter, (req, res) => {
    const configuredKey = getDriveAdminKey();
    if (!configuredKey) {
        driveAdminFailure(res, 'DRIVE_ADMIN_AUTH_NOT_CONFIGURED', 503, 'Google Drive administrator access is not configured on the server.');
        return;
    }
    const submittedKey = Buffer.from(String(req.body?.key || ''), 'utf8');
    const expectedKey = Buffer.from(configuredKey, 'utf8');
    if (!submittedKey.length || submittedKey.length !== expectedKey.length || !timingSafeEqual(submittedKey, expectedKey)) {
        driveAdminFailure(res, 'DRIVE_ADMIN_AUTH_INVALID', 401, 'Administrator key is not valid.');
        return;
    }
    const token = createSignedToken('drive-admin-session', DRIVE_ADMIN_SESSION_TTL_MS);
    const secure = isProduction ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${DRIVE_ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(DRIVE_ADMIN_SESSION_TTL_MS / 1000)}${secure}`);
    res.json({ success: true, authorized: true });
});

app.delete('/api/drive/admin/session', (_req, res) => {
    const secure = isProduction ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${DRIVE_ADMIN_COOKIE}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    res.json({ success: true, authorized: false });
});

app.get('/api/drive/auth', requireDriveAdmin, async (req, res) => {
    try {
        const state = createOAuthState();
        const authUrl = await buildGoogleDriveAuthUrl(state);
        res.json({ success: true, provider: 'googleDrive', authUrl });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/oauth2callback', async (req, res) => {
    const redirectToFrontend = (key, value, extraParams = {}) => {
        const destination = new URL('/', frontendUrl);
        destination.searchParams.set(key, value);
        for (const [param, paramValue] of Object.entries(extraParams)) destination.searchParams.set(param, paramValue);
        res.redirect(destination.toString());
    };
    try {
        const code = String(req.query.code || '').trim();
        const state = String(req.query.state || '');
        if (!isValidOAuthState(state)) {
            redirectToFrontend('drive', 'error', { drive_code: 'authorization_state_invalid' });
            return;
        }
        if (req.query.error) {
            redirectToFrontend('drive', 'error', { drive_code: req.query.error === 'access_denied' ? 'authorization_cancelled' : 'oauth_error' });
            return;
        }
        if (!code) {
            redirectToFrontend('drive', 'error', { drive_code: 'connection_failed' });
            return;
        }
        await exchangeGoogleDriveCode(code);
        redirectToFrontend('drive', 'connected');
    } catch (error) {
        redirectToFrontend('drive', 'error', { drive_code: error.code || 'connection_failed' });
    }
});

async function disconnectGoogleDrive(_req, res) {
    try {
        await clearGoogleDriveToken();
        res.json({ success: true, provider: 'googleDrive', connected: false });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
}

app.post('/api/drive/disconnect', requireDriveAdmin, disconnectGoogleDrive);
app.post('/api/drive/logout', requireDriveAdmin, disconnectGoogleDrive);

app.get('/api/drive/auth/status', async (req, res) => {
    try {
        const status = await getGoogleDriveStatus();
        res.json({
            ...status,
            success: true,
            connected: Boolean(status.connected),
            adminAuthConfigured: Boolean(getDriveAdminKey()),
            adminAuthorized: isDriveAdminAuthorized(req)
        });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/health', async (_req, res) => {
    const health = await getHealthStatus({
        databaseConfigured: isSupabaseConfigured(),
        checkDatabase: () => candidateDataStore.checkHealth()
    });
    res.status(health.statusCode).json(health.body);
});

app.get('/api/ai/status', async (_req, res) => {
    try {
        res.json(await getAiStatus());
    } catch (error) {
        console.error('AI status check failed:', error);
        res.status(500).json({ message: 'The AI service is temporarily unavailable.' });
    }
});

app.get('/api/drive/status', async (_req, res) => {
    try {
        res.json(await getGoogleDriveStatus());
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/test', async (_req, res) => {
    try {
        const result = await testGoogleDriveConnection();
        res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/folders', requireCandidateSession, async (_req, res) => {
    try {
        const contents = await listDriveFolderContents(getGoogleDriveRootFolderId());
        res.json({ success: true, provider: 'googleDrive', ...contents });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/folders/:folderId', requireCandidateSession, async (req, res) => {
    try {
        const contents = await listDriveFolderContents(req.params.folderId);
        res.json({ success: true, provider: 'googleDrive', ...contents });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/files', requireCandidateSession, async (req, res) => {
    try {
        if (req.query.subject !== undefined || req.query.topic !== undefined || req.query.exam !== undefined) {
            const exam = String(req.query.exam || '').trim();
            const subject = String(req.query.subject || '').trim();
            const topic = String(req.query.topic || '').trim();
            if (!exam || !subject || !topic) {
                res.status(400).json({ success: false, ok: false, provider: 'google-drive', code: 'INVALID_REQUEST', message: 'Choose an exam, subject, and topic to view Google Drive notes.' });
                return;
            }
            const contents = await listDriveTopicFiles(subject, topic);
            res.json({
                ok: true,
                success: true,
                provider: 'google-drive',
                exam,
                configured: true,
                available: true,
                authenticated: true,
                connected: true,
                rootFolderConfigured: true,
                rootFolderAccessible: true,
                rootFolderId: contents.rootFolder.id,
                rootFolderName: contents.rootFolder.name,
                ...contents
            });
            return;
        }
        const folderId = String(req.query.folderId || getGoogleDriveRootFolderId()).trim();
        const contents = await listDriveFolderContents(folderId);
        res.json({ success: true, provider: 'googleDrive', folder: contents.folder, files: contents.files });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.use('/api/drive', createCandidateDriveUploadRouter({
    allowedOrigins,
    requireCandidateSession,
    rateLimiter: candidateDriveUploadRateLimiter,
    sendFailure: sendGoogleDriveFailure
}));

app.post('/api/drive/upload', requireDriveAdmin, express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
    try {
        const result = await uploadTopicFile(
            String(req.query.folderId || ''),
            String(req.query.parentFolderId || ''),
            String(req.query.name || ''),
            String(req.query.mimeType || ''),
            req.body
        );
        res.status(201).json({ success: true, provider: 'googleDrive', file: result });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.post('/api/drive/folders/provision', requireDriveAdmin, async (req, res) => {
    try {
        const result = await provisionSubjectTopicFolders(req.body?.subjects);
        res.json({ success: true, provider: 'googleDrive', ...result });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.post('/api/drive/folders/:folderId/files', requireDriveAdmin, express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
    try {
        const result = await uploadTopicFile(
            req.params.folderId,
            String(req.query.parentFolderId || ''),
            String(req.query.name || ''),
            String(req.query.mimeType || ''),
            req.body
        );
        res.status(201).json({ success: true, provider: 'googleDrive', file: result });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/folders/:folderId/files/:fileId/content', requireCandidateSession, async (req, res) => {
    try {
        const file = await getTopicFileContent(
            req.params.fileId,
            req.params.folderId,
            String(req.query.parentFolderId || '')
        );
        const safeName = file.name.replace(/[\r\n"\\]/g, '_');
        const encodedName = encodeURIComponent(safeName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        res.setHeader('Content-Type', file.mimeType);
        res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodedName}`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.send(file.content);
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/files/:fileId', requireCandidateSession, async (req, res) => {
    try {
        const file = await getDriveFileContent(req.params.fileId, String(req.query.folderId || req.query.parentFolderId || ''));
        sendDriveFileContent(res, file, req.query.download === '1');
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.delete('/api/drive/files/:fileId', requireDriveAdmin, async (req, res) => {
    try {
        const result = await deleteDriveFile(req.params.fileId, String(req.query.folderId || req.query.parentFolderId || ''));
        res.json({ success: true, provider: 'googleDrive', ...result });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

function sendDriveFileContent(res, file, download) {
    const safeName = file.name.replace(/[\r\n"\\]/g, '_');
    const encodedName = encodeURIComponent(safeName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodedName}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.content);
}

function sendGoogleDriveFailure(res, error) {
    const requestId = randomUUID();
    const messages = {
        INVALID_REQUEST: [400, 'Choose a subject and topic to view Google Drive notes.'],
        MISSING_GOOGLE_OAUTH_CONFIG: [503, 'Google Drive is not configured. Set Google OAuth credentials on the server.'],
        MISSING_DRIVE_TOKEN_ENCRYPTION_KEY: [503, 'Google Drive token encryption is not configured on the server.'],
        MISSING_ROOT_FOLDER: [503, 'Google Drive notes folder is not configured.'],
        DRIVE_TOKEN_STORAGE_NOT_CONFIGURED: [503, 'Configure durable Google Drive token storage before connecting.'],
        SUBJECT_FOLDER_NOT_FOUND: [404, 'No subject folder found in the configured Notes Library.'],
        TOPIC_FOLDER_NOT_FOUND: [404, 'No notes folder found for this topic.'],
        GOOGLE_REDIRECT_URI_MISMATCH: [503, 'The Google OAuth redirect URI must match the HTTPS callback registered in Google Cloud.'],
        GOOGLE_INVALID_CLIENT: [503, 'The configured Google OAuth client ID or secret is invalid.'],
        GOOGLE_UNAUTHORIZED_CLIENT: [503, 'The Google OAuth client is not authorized for this application.'],
        DRIVE_PERMISSION_DENIED: [403, 'Google Drive is connected, but this Google account does not have access to the folder.'],
        FOLDER_ACCESS_FAILED: [403, 'The authorized Google account cannot access the configured Notes Library folder.'],
        DRIVE_FILE_NOT_FOUND: [404, 'The requested file is not available in this topic folder.'],
        DRIVE_TOKEN_STORAGE_FAILED: [503, 'The saved Google Drive authorization could not be accessed.'],
        DRIVE_QUOTA_EXCEEDED: [403, 'Google Drive storage quota has been reached. Free up space in the Drive account or switch to a Drive account with available storage before uploading files.'],
        DRIVE_FOLDER_NOT_FOUND: [404, 'The configured Google Drive notes folder was not found.'],
        DRIVE_AUTH_FAILED: [503, 'Google Drive authentication failed. Please reconnect with your Google account.'],
        DRIVE_AUTH_REVOKED: [503, 'Google Drive authorization expired or was revoked. Reconnect the Google account.'],
        AUTH_REQUIRED: [503, 'Google Drive authorization is required. Connect the Google account to continue.'],
        DRIVE_API_NOT_ENABLED: [503, 'Google Drive API is not enabled for the configured Google Cloud project.'],
        DRIVE_RATE_LIMITED: [429, 'Google Drive is receiving too many requests. Wait briefly and try again.'],
        DRIVE_BAD_REQUEST: [400, 'Google Drive rejected the request. Check the selected file or folder and try again.'],
        DRIVE_API_FAILED: [502, 'Google Drive is temporarily unavailable. Please try again later.'],
        UNSUPPORTED_FILE_TYPE: [415, 'This file type is not supported.'],
        FILE_TOO_LARGE: [413, 'Files must be 20 MB or smaller.']
    };
    const [status, defaultMessage] = error.code === 'INVALID_REQUEST'
        ? [400, error.message]
        : messages[error.code] || [502, 'Google Drive request could not be completed.'];
    const message = error.code === 'DRIVE_PERMISSION_DENIED' && /Editor access/.test(error.message || '')
        ? error.message
        : defaultMessage;
    console.error(JSON.stringify({ requestId, provider: 'googleDrive', code: error.code || 'DRIVE_API_FAILED' }));
    res.status(status).json({
        success: false,
        ok: false,
        available: false,
        provider: 'google-drive',
        code: error.code || 'DRIVE_API_FAILED',
        message,
        requestId,
        ...(process.env.NODE_ENV !== 'production' && error.diagnostics ? { diagnostics: error.diagnostics } : {})
    });
}

function sendProviderFailure(res, provider, error) {
    const requestId = randomUUID();
    const actualProvider = error.provider && error.provider !== 'ai' ? error.provider : provider;
    const status = error.code === 'INVALID_REQUEST' ? 400 : 502;
    const reason = sanitizeApiError(error.diagnostics?.reason || error.message || 'Provider request failed.');
    const diagnostics = {
        ...error.diagnostics,
        reason,
        httpStatus: error.diagnostics?.httpStatus || status
    };
    console.error(JSON.stringify({ requestId, provider: actualProvider, code: error.code || 'PROVIDER_FAILURE', ...diagnostics }));
    res.status(status).json({
        success: false,
        provider: actualProvider,
        code: error.code || 'PROVIDER_FAILURE',
        message: describeAiFailure(error, `${actualProvider} could not complete the request.`),
        requestId,
        ...(process.env.NODE_ENV !== 'production' ? { diagnostics } : {})
    });
}

app.post('/api/ai/questions', requireCandidateSession, aiRateLimiter, questionRateLimiter, async (req, res) => {
    try {
        const payload = req.body || {};
        const result = await generateQuestions(payload);
        const questions = result.map((question) => Object.fromEntries(
            Object.entries(question).filter(([key]) => !/correct.?answer|answer.?key|solution.?key|^explanation$|^shortcut$/i.test(key))
        ));
        res.json({ questions });
    } catch (error) {
        sendProviderFailure(res, 'Gemini', error);
    }
});

app.post('/api/ai/notes', requireCandidateSession, aiRateLimiter, async (req, res) => {
    try {
        const payload = req.body || {};
        const result = await generateNotes(payload);
        res.json({ notes: result });
    } catch (error) {
        sendProviderFailure(res, 'Groq', error);
    }
});

app.post('/api/ai/chat', requireCandidateSession, aiRateLimiter, async (req, res) => {
    try {
        const payload = req.body || {};
        const result = await generateChatReply(payload);
        res.json({ reply: result });
    } catch (error) {
        sendProviderFailure(res, 'OpenRouter', error);
    }
});

app.use('/api', (_req, res) => {
    res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'API route not found.' });
});

app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const requestId = randomUUID();
    const status = Number(error.status || error.statusCode) || 500;
    const code = error.type === 'entity.parse.failed' ? 'INVALID_JSON'
        : status === 413 ? 'REQUEST_TOO_LARGE'
            : 'REQUEST_FAILED';
    const message = code === 'INVALID_JSON' ? 'Request body must contain valid JSON.'
        : code === 'REQUEST_TOO_LARGE' ? 'Request body is too large.'
            : 'The request could not be completed.';
    console.error(JSON.stringify({ requestId, method: req.method, path: req.path, code }));
    res.status(status >= 400 && status < 600 ? status : 500).json({ success: false, code, message, requestId });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI server running on port ${PORT}`);
    void getAiStatus().then((status) => {
        for (const provider of ['gemini', 'groq', 'openrouter']) {
            const name = provider[0].toUpperCase() + provider.slice(1);
            console.log(`${name} keys configured: ${status[provider].configuredKeys}/20`);
            console.log(`${name} models configured: ${status[provider].configuredModels}`);
        }
    });
});
