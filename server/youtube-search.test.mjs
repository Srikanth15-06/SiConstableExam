import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createYouTubeSearchHandler } from './youtube-search.mjs';

function createResponseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

function createRequest(query) {
    return { query };
}

test('YouTube search validates query and page token before calling Google', async () => {
    let requests = 0;
    const handler = createYouTubeSearchHandler({
        apiKey: 'test-key',
        fetchImpl: async () => { requests += 1; },
        logger: { error() {} }
    });

    for (const query of [
        { q: '' },
        { q: 'a'.repeat(101) },
        { q: ['react'] },
        { q: 'react', pageToken: 'invalid token' },
        { q: 'react', pageToken: 'x'.repeat(513) }
    ]) {
        const response = createResponseRecorder();
        await handler(createRequest(query), response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.success, false);
    }
    assert.equal(requests, 0);
});

test('YouTube search requests embeddable videos and maps public snippet fields', async () => {
    let requestedUrl;
    const handler = createYouTubeSearchHandler({
        apiKey: 'server-only-key',
        cache: new Map(),
        fetchImpl: async (url) => {
            requestedUrl = new URL(url);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    nextPageToken: 'next-page',
                    items: [{
                        id: { videoId: 'abcdefghijk' },
                        snippet: {
                            title: 'React tutorial',
                            channelTitle: 'Example channel',
                            description: 'Learn React.',
                            publishedAt: '2026-01-02T03:04:05Z',
                            thumbnails: { high: { url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' } }
                        }
                    }]
                })
            };
        },
        logger: { error() {} }
    });
    const response = createResponseRecorder();

    await handler(createRequest({ q: '  React tutorial  ' }), response);

    assert.equal(requestedUrl.origin, 'https://www.googleapis.com');
    assert.equal(requestedUrl.searchParams.get('key'), 'server-only-key');
    assert.equal(requestedUrl.searchParams.get('q'), 'React tutorial');
    assert.equal(requestedUrl.searchParams.get('type'), 'video');
    assert.equal(requestedUrl.searchParams.get('videoEmbeddable'), 'true');
    assert.equal(requestedUrl.searchParams.get('maxResults'), '12');
    assert.deepEqual(response.body, {
        success: true,
        nextPageToken: 'next-page',
        videos: [{
            videoId: 'abcdefghijk',
            title: 'React tutorial',
            thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
            channelName: 'Example channel',
            description: 'Learn React.',
            publishedAt: '2026-01-02T03:04:05Z'
        }]
    });
});

test('YouTube search caches successful pages by query and token', async () => {
    let requests = 0;
    const handler = createYouTubeSearchHandler({
        apiKey: 'test-key',
        cache: new Map(),
        fetchImpl: async () => {
            requests += 1;
            return { ok: true, status: 200, json: async () => ({ items: [] }) };
        },
        logger: { error() {} }
    });

    const first = createResponseRecorder();
    const second = createResponseRecorder();
    await handler(createRequest({ q: 'Python tutorials' }), first);
    await handler(createRequest({ q: 'python tutorials' }), second);

    assert.equal(requests, 1);
    assert.deepEqual(second.body, first.body);
});

test('YouTube search reports missing configuration without making an upstream request', async () => {
    let requests = 0;
    const handler = createYouTubeSearchHandler({
        apiKey: '',
        fetchImpl: async () => { requests += 1; },
        logger: { error() {} }
    });
    const response = createResponseRecorder();

    await handler(createRequest({ q: 'React' }), response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'YOUTUBE_NOT_CONFIGURED');
    assert.equal(requests, 0);
});

test('YouTube search reports quota exhaustion explicitly', async () => {
    const handler = createYouTubeSearchHandler({
        apiKey: 'test-key',
        cache: new Map(),
        fetchImpl: async () => ({
            ok: false,
            status: 403,
            json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } })
        }),
        logger: { error() {} }
    });
    const response = createResponseRecorder();

    await handler(createRequest({ q: 'Python' }), response);

    assert.equal(response.statusCode, 429);
    assert.equal(response.body.code, 'YOUTUBE_QUOTA_EXCEEDED');
});

test('YouTube search reports generic API and network failures without exposing provider details', async () => {
    const logger = { error() {} };
    const failingHandlers = [
        createYouTubeSearchHandler({
            apiKey: 'test-key',
            cache: new Map(),
            fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'secret provider detail' } }) }),
            logger
        }),
        createYouTubeSearchHandler({
            apiKey: 'test-key',
            cache: new Map(),
            fetchImpl: async () => { throw new Error('network details'); },
            logger
        })
    ];

    for (const handler of failingHandlers) {
        const response = createResponseRecorder();
        await handler(createRequest({ q: 'arbitrary keywords' }), response);
        assert.equal(response.statusCode, 502);
        assert.equal(response.body.code, 'YOUTUBE_SEARCH_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(response.body), /secret provider detail|network details/);
    }
});
