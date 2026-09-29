import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const driveTestDirectory = await mkdtemp(path.join(os.tmpdir(), 'drive-service-tests-'));
process.env.GOOGLE_DRIVE_TOKEN_FILE = path.join(driveTestDirectory, 'token.enc');
test.after(async () => rm(driveTestDirectory, { recursive: true, force: true }));

delete process.env.ROOT_FOLDER_ID;
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.GOOGLE_REDIRECT_URI = '';
process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'configured-folder-id';
delete process.env.ROOT_FOLDER_ID;
delete process.env.GOOGLE_DRIVE_TOKEN;
delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
delete process.env.GOOGLE_DRIVE_ACCESS_TOKEN;

const {
    buildGoogleDriveAuthUrl,
    clearGoogleDriveToken,
    exchangeGoogleDriveCode,
    getGoogleDriveStatus,
    listDriveFolderContents,
    testGoogleDriveConnection,
    validateGoogleDriveConfig
} = await import('./google-drive-service.mjs');

test('validateGoogleDriveConfig reports OAuth setup state without exposing secrets', () => {
    assert.deepEqual(validateGoogleDriveConfig(), {
        configured: false,
        clientIdConfigured: false,
        clientSecretConfigured: false,
        redirectUriConfigured: false,
        tokenEncryptionKeyConfigured: true,
        rootFolderConfigured: true,
        connected: false
    });

    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = '';
    assert.deepEqual(validateGoogleDriveConfig(), {
        configured: false,
        clientIdConfigured: true,
        clientSecretConfigured: true,
        redirectUriConfigured: true,
        tokenEncryptionKeyConfigured: true,
        rootFolderConfigured: false,
        connected: false
    });

    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'configured-folder-id';
    assert.deepEqual(validateGoogleDriveConfig(), {
        configured: true,
        clientIdConfigured: true,
        clientSecretConfigured: true,
        redirectUriConfigured: true,
        tokenEncryptionKeyConfigured: true,
        rootFolderConfigured: true,
        connected: false
    });

    process.env.GOOGLE_CLIENT_ID = '';
    process.env.GOOGLE_CLIENT_SECRET = '';
    process.env.GOOGLE_REDIRECT_URI = '';
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'configured-folder-id';
});

test('Drive status reports missing OAuth configuration without disclosing secrets', async () => {
    assert.deepEqual(await getGoogleDriveStatus(), {
        success: false,
        provider: 'googleDrive',
        configured: false,
        available: false,
        rootFolderId: 'configured-folder-id',
        checks: { oauth: false, rootFolder: true, driveApi: false, folderAccess: false },
        code: 'MISSING_GOOGLE_OAUTH_CONFIG'
    });
});

test('Drive folder listing refuses invalid OAuth setup before making an external request', async () => {
    await assert.rejects(
        listDriveFolderContents('configured-folder-id'),
        (error) => error.code === 'MISSING_GOOGLE_OAUTH_CONFIG' && error.provider === 'Google Drive'
    );
});

test('Drive classifies malformed OAuth tokens as authentication failures', async () => {
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'configured-folder-id';
    delete process.env.GOOGLE_DRIVE_TOKEN;
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    await assert.rejects(
        listDriveFolderContents('configured-folder-id'),
        (error) => error.code === 'DRIVE_AUTH_FAILED' && !error.message.includes(process.env.GOOGLE_CLIENT_SECRET)
    );
});

test('Drive lists direct child folders/files and handles permission and folder errors', async () => {
    process.env.GOOGLE_CLIENT_ID = 'drive-test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'drive-test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    process.env.GOOGLE_DRIVE_TOKEN = JSON.stringify({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        expiry: Date.now() + 60_000_000,
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer'
    });
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'test-notes-root';
    process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID = 'test-shared-drive';

    const { getGoogleDriveStatus, listDriveFolderContents } = await import('./google-drive-service.mjs');
    const originalFetch = globalThis.fetch;
    let driveStatus = 403;
    const driveUrls = [];
    globalThis.fetch = async (url) => {
        if (String(url).includes('oauth2.googleapis.com/token')) {
            return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), { status: 200 });
        }
        const driveUrl = new URL(url);
        driveUrls.push(driveUrl);
        if (driveStatus !== 200) {
            return new Response(JSON.stringify({ error: { message: driveStatus === 403 ? 'The caller does not have permission' : 'Folder not found' } }), { status: driveStatus });
        }
        if (driveUrl.pathname.endsWith('/test-notes-root')) {
            return new Response(JSON.stringify({ id: 'test-notes-root', name: 'Notes', mimeType: 'application/vnd.google-apps.folder' }), { status: 200 });
        }
        const folderMetadata = {
            'english-id': { id: 'english-id', name: 'English', mimeType: 'application/vnd.google-apps.folder' },
            'arithmetic-id': { id: 'arithmetic-id', name: 'Arithmetic', mimeType: 'application/vnd.google-apps.folder' },
            'sentences-id': { id: 'sentences-id', name: 'Sentences', mimeType: 'application/vnd.google-apps.folder' },
            'percent-topic': { id: 'percent-topic', name: 'Percentage', mimeType: 'application/vnd.google-apps.folder' }
        };
        const metadataMatch = driveUrl.pathname.match(/\/files\/([^/]+)$/);
        if (metadataMatch) {
            if (driveStatus !== 200) {
                return new Response(JSON.stringify({ error: { message: driveStatus === 403 ? 'The caller does not have permission' : 'Folder not found' } }), { status: driveStatus });
            }
            const metadata = folderMetadata[metadataMatch[1]];
            return metadata
                ? new Response(JSON.stringify(metadata), { status: 200 })
                : new Response(JSON.stringify({ error: { message: 'Folder not found' } }), { status: 404 });
        }
        const parent = driveUrl.searchParams.get('q')?.match(/'([^']+)' in parents/)?.[1];
        const children = {
            'test-notes-root': [folderMetadata['english-id'], folderMetadata['arithmetic-id']],
            'english-id': [folderMetadata['sentences-id']],
            'arithmetic-id': [{ id: 'percent-topic', name: 'Percentage', mimeType: 'application/vnd.google-apps.folder' }],
            'sentences-id': [
                { id: 'sentence-pdf', name: 'Sentence Notes.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.test/sentence-pdf', size: '4096', modifiedTime: '2026-01-02T00:00:00Z' },
                { id: 'sentence-image', name: 'Sentence Chart.webp', mimeType: 'image/webp', webViewLink: 'https://drive.google.test/sentence-image', thumbnailLink: 'https://drive.google.test/sentence-image-thumb' },
                { id: 'unrelated-zip', name: 'archive.zip', mimeType: 'application/zip' }
            ],
            'percent-topic': []
        };
        return new Response(JSON.stringify({ files: children[parent] || [] }), { status: 200 });
    };

    try {
        driveStatus = 200;
        assert.deepEqual(await getGoogleDriveStatus(), {
            success: true,
            provider: 'googleDrive',
            configured: true,
            available: true,
            rootFolderId: 'test-notes-root',
            checks: { oauth: true, rootFolder: true, driveApi: true, folderAccess: true }
        });
        assert.deepEqual(await testGoogleDriveConnection(), { folderAccessible: true });
        driveStatus = 403;
        await assert.rejects(listDriveFolderContents('english-id'), (error) => error.code === 'DRIVE_PERMISSION_DENIED');
        driveStatus = 404;
        await assert.rejects(listDriveFolderContents('english-id'), (error) => error.code === 'DRIVE_FOLDER_NOT_FOUND');
        driveStatus = 200;
        const root = await listDriveFolderContents('test-notes-root');
        assert.deepEqual(root.folders.map((folder) => folder.name), ['English', 'Arithmetic']);
        assert.deepEqual(root.files, []);
        const subject = await listDriveFolderContents('english-id');
        assert.deepEqual(subject.folders.map((folder) => folder.name), ['Sentences']);
        assert.deepEqual(subject.files, []);
        const topic = await listDriveFolderContents('sentences-id');
        assert.deepEqual(topic.folders, []);
        assert.deepEqual(topic.files.map((file) => file.id), ['sentence-pdf', 'sentence-image']);
        assert.equal(topic.files[1].type, 'image');
        assert.equal(topic.files[0].webViewLink, 'https://drive.google.test/sentence-pdf');
        assert.equal(topic.files[0].size, '4096');
        assert.equal(topic.files[0].modifiedTime, '2026-01-02T00:00:00Z');
        assert.equal(Object.hasOwn(topic.files[0], 'access_token'), false);
        assert.ok(driveUrls.every((url) => url.searchParams.get('supportsAllDrives') === 'true'));
        assert.ok(driveUrls.every((url) => url.searchParams.get('includeItemsFromAllDrives') === 'true'));
        assert.ok(driveUrls.every((url) => url.searchParams.get('driveId') === 'test-shared-drive'));
        assert.deepEqual((await listDriveFolderContents('percent-topic')).files, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Drive provisioning reuses matching folders case-insensitively and creates only missing subject/topic folders', async () => {
    process.env.GOOGLE_CLIENT_ID = 'writer-test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'writer-test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    process.env.GOOGLE_DRIVE_TOKEN = JSON.stringify({
        access_token: 'writer-test-token',
        refresh_token: 'writer-refresh-token',
        expires_in: 3600,
        expiry: Date.now() + 60_000_000,
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer'
    });
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'provision-root';
    process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID = '';
    const { provisionSubjectTopicFolders } = await import('./google-drive-service.mjs');
    const originalFetch = globalThis.fetch;
    const folderMap = {
        'provision-root': [{ id: 'english-id', name: 'english', mimeType: 'application/vnd.google-apps.folder' }],
        'english-id': [{ id: 'tenses-id', name: 'tenses', mimeType: 'application/vnd.google-apps.folder' }]
    };
    let created = 0;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).includes('oauth2.googleapis.com/token')) {
            return new Response(JSON.stringify({ access_token: 'writer-test-token', expires_in: 3600 }), { status: 200 });
        }
        const requestUrl = new URL(url);
        if (requestUrl.pathname.endsWith('/provision-root')) {
            return new Response(JSON.stringify({ id: 'provision-root', name: 'Notes', mimeType: 'application/vnd.google-apps.folder' }), { status: 200 });
        }
        if (options.method === 'POST') {
            const metadata = JSON.parse(options.body);
            const file = { id: `created-${++created}`, ...metadata };
            folderMap[metadata.parents[0]] ||= [];
            folderMap[metadata.parents[0]].push(file);
            folderMap[file.id] = [];
            return new Response(JSON.stringify(file), { status: 200 });
        }
        const parent = requestUrl.searchParams.get('q')?.match(/'([^']+)' in parents/)?.[1];
        return new Response(JSON.stringify({ files: folderMap[parent] || [] }), { status: 200 });
    };

    try {
        const result = await provisionSubjectTopicFolders([
            { name: 'English', topics: ['Tenses', 'Sentences'] },
            { name: 'Arithmetic', topics: ['Percentages'] }
        ]);
        assert.deepEqual(result, { subjectsProcessed: 2, topicsProcessed: 3, createdSubjects: 1, createdTopics: 2 });
        const secondRun = await provisionSubjectTopicFolders([
            { name: 'English', topics: ['Tenses', 'Sentences'] },
            { name: 'Arithmetic', topics: ['Percentages'] }
        ]);
        assert.deepEqual(secondRun, { subjectsProcessed: 2, topicsProcessed: 3, createdSubjects: 0, createdTopics: 0 });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Drive image upload validates topic ancestry and writes file bytes to that folder', async () => {
    process.env.GOOGLE_CLIENT_ID = 'upload-test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'upload-test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    process.env.GOOGLE_DRIVE_TOKEN = JSON.stringify({
        access_token: 'upload-test-token',
        refresh_token: 'upload-refresh-token',
        expires_in: 3600,
        expiry: Date.now() + 60_000_000,
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer'
    });
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'upload-root';
    process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID = '';
    const { uploadTopicFile } = await import('./google-drive-service.mjs');
    const originalFetch = globalThis.fetch;
    let uploadRequest;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).includes('oauth2.googleapis.com/token')) {
            return new Response(JSON.stringify({ access_token: 'upload-test-token', expires_in: 3600 }), { status: 200 });
        }
        const requestUrl = new URL(url);
        if (requestUrl.pathname.endsWith('/upload-root')) {
            return new Response(JSON.stringify({ id: 'upload-root', name: 'Notes', mimeType: 'application/vnd.google-apps.folder' }), { status: 200 });
        }
        if (requestUrl.pathname.endsWith('/subject-id')) {
            return new Response(JSON.stringify({ id: 'subject-id', name: 'English', mimeType: 'application/vnd.google-apps.folder' }), { status: 200 });
        }
        if (requestUrl.pathname.endsWith('/topic-id')) {
            return new Response(JSON.stringify({ id: 'topic-id', name: 'Sentences', mimeType: 'application/vnd.google-apps.folder' }), { status: 200 });
        }
        if (requestUrl.pathname.endsWith('/files') && options.method === 'POST') {
            uploadRequest = { url: requestUrl, headers: options.headers, body: options.body };
            return new Response(JSON.stringify({ id: 'uploaded-image', name: 'chart.webp', mimeType: 'image/webp', webViewLink: 'https://drive.google.test/chart' }), { status: 200 });
        }
        const parent = requestUrl.searchParams.get('q')?.match(/'([^']+)' in parents/)?.[1];
        const folders = parent === 'upload-root' ? [{ id: 'subject-id', mimeType: 'application/vnd.google-apps.folder' }]
            : parent === 'subject-id' ? [{ id: 'topic-id', mimeType: 'application/vnd.google-apps.folder' }] : [];
        return new Response(JSON.stringify({ files: folders }), { status: 200 });
    };

    try {
        const fileBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);
        const uploaded = await uploadTopicFile('topic-id', 'subject-id', 'chart.webp', 'image/webp', fileBytes);
        assert.equal(uploaded.id, 'uploaded-image');
        assert.equal(uploaded.type, 'image');
        assert.equal(uploadRequest.url.searchParams.get('uploadType'), 'multipart');
        assert.match(uploadRequest.headers['Content-Type'], /multipart\/related/);
        assert.ok(uploadRequest.body.includes(Buffer.from('"parents":["topic-id"]')));
        assert.ok(uploadRequest.body.includes(fileBytes));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Drive file preview exports Google Docs inside the selected topic only', async () => {
    process.env.GOOGLE_CLIENT_ID = 'preview-test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'preview-test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    process.env.GOOGLE_DRIVE_TOKEN = JSON.stringify({
        access_token: 'preview-test-token',
        refresh_token: 'preview-refresh-token',
        expires_in: 3600,
        expiry: Date.now() + 60_000_000,
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer'
    });
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'preview-root';
    process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID = '';
    const { getTopicFileContent } = await import('./google-drive-service.mjs');
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url) => {
        const requestUrl = new URL(url);
        requests.push(requestUrl);
        if (requestUrl.pathname.endsWith('/preview-root')) {
            return new Response(JSON.stringify({ id: 'preview-root', name: 'Notes', mimeType: 'application/vnd.google-apps.folder' }), { status: 200 });
        }
        if (requestUrl.pathname.endsWith('/export')) {
            return new Response(Buffer.from('pdf-preview-bytes'), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
        }
        const parent = requestUrl.searchParams.get('q')?.match(/'([^']+)' in parents/)?.[1];
        const children = parent === 'preview-root'
            ? [{ id: 'preview-subject', name: 'English', mimeType: 'application/vnd.google-apps.folder' }]
            : parent === 'preview-subject'
                ? [{ id: 'preview-topic', name: 'Tenses', mimeType: 'application/vnd.google-apps.folder' }]
                : parent === 'preview-topic'
                    ? [{ id: 'google-doc-id', name: 'Tenses Notes', mimeType: 'application/vnd.google-apps.document' }]
                    : [];
        return new Response(JSON.stringify({ files: children }), { status: 200 });
    };

    try {
        const preview = await getTopicFileContent('google-doc-id', 'preview-topic', 'preview-subject');
        assert.equal(preview.name, 'Tenses Notes.pdf');
        assert.equal(preview.mimeType, 'application/pdf');
        assert.equal(preview.content.toString(), 'pdf-preview-bytes');
        const exportRequest = requests.find((url) => url.pathname.endsWith('/export'));
        assert.equal(exportRequest.searchParams.get('mimeType'), 'application/pdf');
        await assert.rejects(
            getTopicFileContent('outside-file-id', 'preview-topic', 'preview-subject'),
            (error) => error.code === 'DRIVE_FILE_NOT_FOUND'
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Drive marks storage quota failures as a clear user-actionable error', async () => {
    process.env.GOOGLE_CLIENT_ID = 'quota-test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'quota-test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    process.env.GOOGLE_DRIVE_TOKEN = JSON.stringify({
        access_token: 'quota-test-token',
        refresh_token: 'quota-refresh-token',
        expires_in: 3600,
        expiry: Date.now() + 60_000_000,
        scope: 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer'
    });
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'quota-root';
    process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID = '';
    const { listDriveFolderContents } = await import('./google-drive-service.mjs');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes('oauth2.googleapis.com/token')) {
            return new Response(JSON.stringify({ access_token: 'quota-test-token', expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({
            error: {
                message: 'The user has exceeded the storage quota for this Drive.',
                errors: [{ reason: 'storageQuotaExceeded' }]
            }
        }), { status: 403 });
    };

    try {
        await assert.rejects(
            listDriveFolderContents('quota-root'),
            (error) => error.code === 'DRIVE_QUOTA_EXCEEDED' && /storage quota|free up space/i.test(error.message)
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Google OAuth URL carries a single-encoded Drive scope and state value', async () => {
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    const authUrl = new URL(await buildGoogleDriveAuthUrl('csrf-state-value'));
    assert.equal(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive');
    assert.equal(authUrl.searchParams.get('state'), 'csrf-state-value');
    assert.equal(authUrl.searchParams.get('access_type'), 'offline');
});

test('OAuth exchange persists tokens as encrypted server-side data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'drive-oauth-test-'));
    const tokenFilePath = path.join(directory, 'token.enc');
    const originalFetch = globalThis.fetch;
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/drive/oauth2callback';
    process.env.GOOGLE_DRIVE_TOKEN_FILE = tokenFilePath;
    delete process.env.GOOGLE_DRIVE_TOKEN;
    globalThis.fetch = async (_url, options) => {
        assert.equal(new URLSearchParams(options.body).get('grant_type'), 'authorization_code');
        return new Response(JSON.stringify({
            access_token: 'access-secret-for-test',
            refresh_token: 'refresh-secret-for-test',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive',
            token_type: 'Bearer'
        }), { status: 200 });
    };

    try {
        assert.deepEqual(await exchangeGoogleDriveCode('test-code'), { connected: true, expiresIn: 3600 });
        const persisted = await readFile(tokenFilePath, 'utf8');
        assert.doesNotMatch(persisted, /access-secret-for-test|refresh-secret-for-test/);
        assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), ['data', 'iv', 'tag']);
    } finally {
        globalThis.fetch = originalFetch;
        await clearGoogleDriveToken();
        delete process.env.GOOGLE_DRIVE_TOKEN_FILE;
        await rm(directory, { recursive: true, force: true });
    }
});