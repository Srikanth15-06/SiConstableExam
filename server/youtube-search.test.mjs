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
        { q: 'react', pageToken: 'x'.repeat(513) },
        { q: 'react', duration: 'extreme' },
        { q: 'react', order: 'random' },
        { q: 'react', language: 'fr' }
    ]) {
        const response = createResponseRecorder();
        await handler(createRequest(query), response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.success, false);
    }
    assert.equal(requests, 0);
});

test('YouTube search requests embeddable videos and maps public snippet fields', async () => {
    const requestedUrls = [];
    const handler = createYouTubeSearchHandler({
        apiKey: 'server-only-key',
        cache: new Map(),
        fetchImpl: async (url) => {
            const requestedUrl = new URL(url);
            requestedUrls.push(requestedUrl);
            if (requestedUrl.pathname.endsWith('/videos')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        items: [{ id: 'abcdefghijk', contentDetails: { duration: 'P1DT1H2M3S' } }]
                    })
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    nextPageToken: 'next-page',
                    items: [{
                        id: { videoId: 'abcdefghijk' },
                        snippet: {
                            title: 'React tutorial',
                            channelId: 'UC-example',
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

    const searchUrl = requestedUrls[0];
    assert.equal(searchUrl.origin, 'https://www.googleapis.com');
    assert.equal(searchUrl.searchParams.get('key'), 'server-only-key');
    assert.equal(searchUrl.searchParams.get('q'), 'React tutorial');
    assert.equal(searchUrl.searchParams.get('type'), 'video');
    assert.equal(searchUrl.searchParams.get('videoEmbeddable'), 'true');
    assert.equal(searchUrl.searchParams.get('videoCategoryId'), '27');
    assert.equal(searchUrl.searchParams.get('videoDuration'), 'any');
    assert.equal(searchUrl.searchParams.get('order'), 'relevance');
    assert.equal(searchUrl.searchParams.get('maxResults'), '12');
    assert.equal(requestedUrls[1].pathname, '/youtube/v3/videos');
    assert.equal(requestedUrls[1].searchParams.get('part'), 'contentDetails');
    assert.deepEqual(response.body, {
        success: true,
        nextPageToken: 'next-page',
        videos: [{
            videoId: 'abcdefghijk',
        channelId: 'UC-example',
            title: 'React tutorial',
            thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
            channelName: 'Example channel',
            description: 'Learn React.',
            publishedAt: '2026-01-02T03:04:05Z',
            durationSeconds: 90_123
        }]
    });
});

test('YouTube search caches successful pages by query, token, and language', async () => {
    let searchRequests = 0;
    const handler = createYouTubeSearchHandler({
        apiKey: 'test-key',
        cache: new Map(),
        fetchImpl: async (url) => {
            if (new URL(url).pathname.endsWith('/search')) searchRequests += 1;
            return { ok: true, status: 200, json: async () => ({ items: [] }) };
        },
        logger: { error() {} }
    });

    const first = createResponseRecorder();
    const second = createResponseRecorder();
    const differentLanguage = createResponseRecorder();
    await handler(createRequest({ q: 'Python tutorials' }), first);
    await handler(createRequest({ q: 'python tutorials' }), second);
    await handler(createRequest({ q: 'python tutorials', language: 'te' }), differentLanguage);

    assert.equal(searchRequests, 2);
    assert.deepEqual(second.body, first.body);
});

test('YouTube search validates category filters and forwards duration and order', async () => {
    let requestedUrl;
    const handler = createYouTubeSearchHandler({
        apiKey: 'test-key',
        cache: new Map(),
        fetchImpl: async (url) => {
            requestedUrl = new URL(url);
            return { ok: true, status: 200, json: async () => ({ items: [] }) };
        },
        logger: { error() {} }
    });

    const response = createResponseRecorder();
    await handler(createRequest({ q: 'Telangana GK', duration: 'long', order: 'date' }), response);

    assert.equal(response.statusCode, 200);
    assert.equal(requestedUrl.searchParams.get('videoCategoryId'), '27');
    assert.equal(requestedUrl.searchParams.get('videoDuration'), 'long');
    assert.equal(requestedUrl.searchParams.get('order'), 'date');
});

test('YouTube search forwards supported language preferences and omits all languages', async () => {
    const requestedUrls = [];
    const handler = createYouTubeSearchHandler({
        apiKey: 'test-key',
        cache: new Map(),
        fetchImpl: async (url) => {
            requestedUrls.push(new URL(url));
            return { ok: true, status: 200, json: async () => ({ items: [] }) };
        },
        logger: { error() {} }
    });

    for (const language of ['te', 'hi', 'en', 'all']) {
        const response = createResponseRecorder();
        await handler(createRequest({ q: 'Telangana GK', language }), response);
        assert.equal(response.statusCode, 200);
    }

    assert.deepEqual(
        requestedUrls.map((url) => url.searchParams.get('relevanceLanguage')),
        ['te', 'hi', 'en', null]
    );
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

test('YouTube search reports quota exhaustion while loading video details', async () => {
    let requestCount = 0;
    const handler = createYouTubeSearchHandler({
        apiKey: 'test-key',
        cache: new Map(),
        fetchImpl: async (url) => {
            requestCount += 1;
            if (new URL(url).pathname.endsWith('/videos')) {
                return {
                    ok: false,
                    status: 403,
                    json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } })
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    items: [{
                        id: { videoId: 'abcdefghijk' },
                        snippet: { title: 'Lesson', channelTitle: 'Study channel' }
                    }]
                })
            };
        },
        logger: { error() {} }
    });
    const response = createResponseRecorder();

    await handler(createRequest({ q: 'Lesson' }), response);

    assert.equal(requestCount, 2);
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
