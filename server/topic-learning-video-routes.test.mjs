import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { once } from 'node:events';
import { InMemorySessionStore } from './auth-service.mjs';
import { createTopicLearningVideoRouter, parseYouTubeUrl } from './topic-learning-video-routes.mjs';

const VIDEO_ID = 'AbCdEfGhI_1';
const VIDEO_URL = `https://youtu.be/${VIDEO_ID}`;

function createVideoStore() {
    const records = [];
    return {
        records,
        async list(context) { return records.filter((video) => video.exam_type === context.examType && video.subject === context.subject && video.topic === context.topic); },
        async create(input) {
            const matching = records.filter((video) => video.exam_type === input.examType && video.subject === input.subject && video.topic === input.topic);
            if (matching.length >= 5) throw Object.assign(new Error('limit'), { code: 'TOPIC_VIDEO_LIMIT' });
            const video = { id: randomUUID(), exam_type: input.examType, subject: input.subject, topic: input.topic, title: input.title, youtube_url: input.youtubeUrl, youtube_video_id: input.videoId, display_order: matching.length + 1 };
            records.push(video);
            return video;
        },
        async update(id, input) {
            const video = records.find((item) => item.id === id);
            if (!video) throw Object.assign(new Error('missing'), { code: 'VIDEO_NOT_FOUND' });
            Object.assign(video, { title: input.title, youtube_url: input.youtubeUrl, youtube_video_id: input.videoId });
            return video;
        },
        async delete(id) {
            const index = records.findIndex((item) => item.id === id);
            if (index < 0) throw Object.assign(new Error('missing'), { code: 'VIDEO_NOT_FOUND' });
            records.splice(index, 1);
        }
    };
}

async function createServer(context) {
    const app = express();
    app.use(express.json());
    const sessions = new InMemorySessionStore();
    const userIds = { si: `usr_${randomUUID()}`, constable: `usr_${randomUUID()}` };
    const cookies = Object.fromEntries(Object.entries(userIds).map(([role, userId]) => [role, sessions.create(userId).sessionId]));
    const allowedOrigins = new Set();
    const dataStore = { async getUserData(userId) { return { exam: userId === userIds.constable ? 'CONSTABLE' : 'SI' }; } };
    const videoStore = createVideoStore();
    app.use('/api', createTopicLearningVideoRouter({ dataStore, videoStore, sessions, allowedOrigins }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    allowedOrigins.add(baseUrl);
    return { baseUrl, cookies, videoStore };
}

function candidateHeaders(cookie, origin, includeOrigin = true) {
    return {
        Cookie: `ts_police_session=${cookie}`,
        ...(includeOrigin ? { Origin: origin } : {}),
        'Content-Type': 'application/json'
    };
}

test('YouTube URL parser accepts watch, short, and shorts URLs and rejects external URLs', () => {
    assert.equal(parseYouTubeUrl(`https://www.youtube.com/watch?v=${VIDEO_ID}`)?.videoId, VIDEO_ID);
    assert.equal(parseYouTubeUrl(VIDEO_URL)?.videoId, VIDEO_ID);
    assert.equal(parseYouTubeUrl(`https://www.youtube.com/shorts/${VIDEO_ID}`)?.videoId, VIDEO_ID);
    assert.equal(parseYouTubeUrl(`https://example.com/watch?v=${VIDEO_ID}`), null);
    assert.equal(parseYouTubeUrl(`http://youtube.com/watch?v=${VIDEO_ID}`), null);
    assert.equal(parseYouTubeUrl('https://youtube.com/watch?v=short'), null);
});

test('candidate video reads use authenticated role and isolate role-specific topics', async (context) => {
    const { baseUrl, cookies, videoStore } = await createServer(context);
    await videoStore.create({ examType: 'SI', subject: 'Arithmetic', topic: 'Percentages', title: 'SI video', youtubeUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`, videoId: VIDEO_ID });
    await videoStore.create({ examType: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', title: 'Constable video', youtubeUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`, videoId: VIDEO_ID });

    for (const [role, expectedTitle] of [['si', 'SI video'], ['constable', 'Constable video']]) {
        const response = await fetch(`${baseUrl}/api/learning-videos?subject=Arithmetic&topic=Percentages&exam=SI`, { headers: { Cookie: `ts_police_session=${cookies[role]}` } });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).videos.map((video) => video.title), [expectedTitle]);
    }
});

test('signed-in candidates can manage videos with trusted origins and the five-video cap', async (context) => {
    const { baseUrl, cookies } = await createServer(context);
    const endpoint = `${baseUrl}/api/admin/learning-videos`;
    const body = (title) => ({ exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', title, youtubeUrl: VIDEO_URL });
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body('Unauthorized')) })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: candidateHeaders(cookies.si, baseUrl, false), body: JSON.stringify(body('Missing origin')) })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: candidateHeaders(cookies.si, 'https://untrusted.example'), body: JSON.stringify(body('Untrusted origin')) })).status, 403);

    const headers = candidateHeaders(cookies.si, baseUrl);
    for (let index = 1; index <= 5; index += 1) {
        const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body(`Video ${index}`)) });
        assert.equal(response.status, 201);
    }
    const sixth = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body('Video 6')) });
    assert.equal(sixth.status, 409);
    assert.match((await sixth.json()).message, /Maximum 5/);
    const invalid = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...body('Invalid'), youtubeUrl: 'https://example.com/video' }) });
    assert.equal(invalid.status, 400);
    const listed = await fetch(`${endpoint}?exam=SI&subject=Arithmetic&topic=Percentages`, { headers });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).videos.length, 5);
});

test('different signed-in candidates can update and delete shared videos', async (context) => {
    const { baseUrl, cookies } = await createServer(context);
    const endpoint = `${baseUrl}/api/admin/learning-videos`;
    const creatorHeaders = candidateHeaders(cookies.si, baseUrl);
    const managerHeaders = candidateHeaders(cookies.constable, baseUrl);
    const created = await fetch(endpoint, { method: 'POST', headers: creatorHeaders, body: JSON.stringify({ exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', title: 'Before', youtubeUrl: VIDEO_URL }) });
    const video = (await created.json()).video;
    const updated = await fetch(`${endpoint}/${video.id}`, { method: 'PATCH', headers: managerHeaders, body: JSON.stringify({ title: 'After', youtubeUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}` }) });
    assert.equal((await updated.json()).video.title, 'After');
    const deleted = await fetch(`${endpoint}/${video.id}`, { method: 'DELETE', headers: managerHeaders });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).success, true);
});

test('learning video migration enforces role, ordering, maximum count, and server-only access', async () => {
    const migration = await readFile(new URL('../supabase/migrations/202610010001_topic_learning_videos.sql', import.meta.url), 'utf8');
    assert.match(migration, /check\s*\(exam_type in \('SI', 'CONSTABLE'\)\)/i);
    assert.match(migration, /check\s*\(display_order between 1 and 5\)/i);
    assert.match(migration, /pg_advisory_xact_lock/i);
    assert.match(migration, /generate_series\(1, 5\)/i);
    assert.match(migration, /unique \(exam_type, subject, topic, display_order\)/i);
    assert.match(migration, /enable row level security/i);
    assert.match(migration, /revoke all on public\.topic_learning_videos from public, anon, authenticated/i);
    assert.match(migration, /to service_role/i);
});