import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { AUTH_COOKIE_NAME, createAuthenticationMiddleware, InMemorySessionStore } from './auth-service.mjs';
import { createCandidateDriveUploadRouter } from './drive-upload-routes.mjs';

async function createServer() {
    const app = express();
    const sessions = new InMemorySessionStore({ ttlMs: 60_000 });
    const userId = `usr_${randomUUID()}`;
    const { sessionId } = sessions.create(userId);
    const uploads = [];
    const allowedOrigins = new Set(['https://frontend.example.test']);
    app.use('/api/drive', createCandidateDriveUploadRouter({
        allowedOrigins,
        requireCandidateSession: createAuthenticationMiddleware(sessions),
        rateLimiter: (_req, _res, next) => next(),
        sendFailure: (res, error) => res.status(500).json({ success: false, code: error.code || 'UPLOAD_FAILED' }),
        async uploadFile(...args) {
            uploads.push(args);
            return { id: 'shared-file-id', name: args[2], mimeType: args[3] };
        }
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
        server,
        uploads
    };
}

test('candidate Drive uploads require a signed-in session and trusted origin', async (context) => {
    const fixture = await createServer();
    context.after(() => new Promise((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())));
    const uploadUrl = `${fixture.baseUrl}/api/drive/candidate/folders/topic-id/files?parentFolderId=subject-id&name=Percentages.pdf&mimeType=application%2Fpdf`;
    const fileBytes = Buffer.from('candidate note bytes');

    const anonymous = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Origin: 'https://frontend.example.test', 'Content-Type': 'application/octet-stream' },
        body: fileBytes
    });
    assert.equal(anonymous.status, 401);

    const untrustedOrigin = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example.test', Cookie: fixture.cookie, 'Content-Type': 'application/octet-stream' },
        body: fileBytes
    });
    assert.equal(untrustedOrigin.status, 403);
    assert.equal(fixture.uploads.length, 0);

    const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Origin: 'https://frontend.example.test', Cookie: fixture.cookie, 'Content-Type': 'application/octet-stream' },
        body: fileBytes
    });
    assert.equal(response.status, 201);
    assert.deepEqual(fixture.uploads, [['topic-id', 'subject-id', 'Percentages.pdf', 'application/pdf', fileBytes]]);
    assert.deepEqual(await response.json(), {
        success: true,
        provider: 'googleDrive',
        file: { id: 'shared-file-id', name: 'Percentages.pdf', mimeType: 'application/pdf' }
    });
});