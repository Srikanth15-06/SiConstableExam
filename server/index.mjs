import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { generateQuestions, generateNotes, generateChatReply, getAiStatus } from './ai-service.mjs';
import { buildGoogleDriveAuthUrl, clearGoogleDriveToken, exchangeGoogleDriveCode, getGoogleDriveStatus, getTopicFileContent, listDriveFolderContents, provisionSubjectTopicFolders, testGoogleDriveConnection, uploadTopicFile } from './google-drive-service.mjs';
import { describeAiFailure, sanitizeApiError } from './provider-manager.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.join(__dirname, '../frontend/dist');

const app = express();
const PORT = Number(process.env.PORT || process.env.AI_SERVER_PORT || 8787);
const isProduction = process.env.NODE_ENV === 'production';
const frontendUrl = process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || (isProduction ? '' : 'http://localhost:5173');
const allowedOrigins = new Set([
    frontendUrl,
    process.env.RENDER_EXTERNAL_URL,
    ...(!isProduction ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [])
].filter(Boolean).map((origin) => new URL(origin).origin));
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : randomBytes(32).toString('hex'));

if (isProduction && !frontendUrl) throw new Error('FRONTEND_URL or RENDER_EXTERNAL_URL must be configured in production.');
if (!sessionSecret) throw new Error('SESSION_SECRET must be configured in production.');
if (isProduction) app.set('trust proxy', 1);

app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

app.use(express.static(frontendDist));

app.get('/api/drive/auth', async (req, res) => {
    try {
        const state = randomBytes(32).toString('hex');
        req.session.googleDriveOAuthState = state;
        await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
        const authUrl = await buildGoogleDriveAuthUrl(state);
        res.json({ success: true, provider: 'googleDrive', authUrl });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/oauth2callback', async (req, res) => {
    const redirectToFrontend = (key, value) => {
        const destination = new URL('/', frontendUrl);
        destination.searchParams.set(key, value);
        res.redirect(destination.toString());
    };
    try {
        const code = String(req.query.code || '').trim();
        const state = String(req.query.state || '');
        const expectedState = String(req.session.googleDriveOAuthState || '');
        delete req.session.googleDriveOAuthState;
        if (!code || !state || !expectedState || state.length !== expectedState.length
            || !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
            redirectToFrontend('drive_error', 'authorization_state_invalid');
            return;
        }
        if (req.query.error) {
            redirectToFrontend('drive_error', 'authorization_cancelled');
            return;
        }
        await exchangeGoogleDriveCode(code);
        redirectToFrontend('drive', 'connected');
    } catch {
        redirectToFrontend('drive_error', 'connection_failed');
    }
});

app.post('/api/drive/logout', async (req, res) => {
    try {
        await clearGoogleDriveToken();
        await new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
        res.json({ success: true, provider: 'googleDrive', connected: false });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/auth/status', async (_req, res) => {
    try {
        const status = await getGoogleDriveStatus();
        res.json({ success: true, provider: 'googleDrive', ...status, connected: status.connected ?? status.available });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'TS Police AI Prep API' });
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
        res.json({ success: true, provider: 'googleDrive', folderAccessible: result.folderAccessible });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.get('/api/drive/folders/:folderId', async (req, res) => {
    try {
        const contents = await listDriveFolderContents(req.params.folderId);
        res.json({ success: true, provider: 'googleDrive', ...contents });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.post('/api/drive/folders/provision', async (req, res) => {
    try {
        const result = await provisionSubjectTopicFolders(req.body?.subjects);
        res.json({ success: true, provider: 'googleDrive', ...result });
    } catch (error) {
        sendGoogleDriveFailure(res, error);
    }
});

app.post('/api/drive/folders/:folderId/files', express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
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

app.get('/api/drive/folders/:folderId/files/:fileId/content', async (req, res) => {
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

function sendGoogleDriveFailure(res, error) {
    const requestId = randomUUID();
    const messages = {
        INVALID_REQUEST: [400, 'Choose a subject and topic to view Google Drive notes.'],
        MISSING_GOOGLE_OAUTH_CONFIG: [503, 'Google Drive is not configured. Set Google OAuth credentials on the server.'],
        MISSING_DRIVE_TOKEN_ENCRYPTION_KEY: [503, 'Google Drive token encryption is not configured on the server.'],
        MISSING_ROOT_FOLDER: [503, 'Google Drive notes folder is not configured.'],
        DRIVE_PERMISSION_DENIED: [403, 'Google Drive is connected, but this Google account does not have access to the folder.'],
        DRIVE_FILE_NOT_FOUND: [404, 'The requested file is not available in this topic folder.'],
        DRIVE_TOKEN_STORAGE_FAILED: [503, 'The saved Google Drive authorization could not be accessed.'],
        DRIVE_QUOTA_EXCEEDED: [403, 'Google Drive storage quota has been reached. Free up space in the Drive account or switch to a Drive account with available storage before uploading files.'],
        DRIVE_FOLDER_NOT_FOUND: [404, 'The configured Google Drive notes folder was not found.'],
        DRIVE_AUTH_FAILED: [503, 'Google Drive authentication failed. Please reconnect with your Google account.'],
        DRIVE_API_FAILED: [502, 'Google Drive is temporarily unavailable. Please try again later.'],
        UNSUPPORTED_FILE_TYPE: [415, 'This file type is not supported.'],
        FILE_TOO_LARGE: [413, 'Files must be 20 MB or smaller.']
    };
    const [status, defaultMessage] = error.code === 'INVALID_REQUEST'
        ? [400, error.message]
        : messages[error.code] || [502, 'Google Drive request could not be completed.'];
    const message = error.code === 'DRIVE_API_FAILED' && error.diagnostics?.failure === 'accessNotConfigured'
        ? 'Google Drive API is not enabled for this Google Cloud project.'
        : error.code === 'DRIVE_PERMISSION_DENIED' && /Editor access/.test(error.message || '')
            ? error.message
            : defaultMessage;
    console.error(JSON.stringify({ requestId, provider: 'googleDrive', code: error.code || 'DRIVE_API_FAILED' }));
    res.status(status).json({
        success: false,
        provider: 'googleDrive',
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

app.post('/api/ai/questions', async (req, res) => {
    try {
        const payload = req.body || {};
        const result = await generateQuestions(payload);
        res.json({ questions: result });
    } catch (error) {
        sendProviderFailure(res, 'Gemini', error);
    }
});

app.post('/api/ai/notes', async (req, res) => {
    try {
        const payload = req.body || {};
        const result = await generateNotes(payload);
        res.json({ notes: result });
    } catch (error) {
        sendProviderFailure(res, 'Groq', error);
    }
});

app.post('/api/ai/chat', async (req, res) => {
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
