const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 250;
const MAX_PAGE_TOKEN_LENGTH = 512;
const SEARCH_CACHE = new Map();

function isValidPageToken(value) {
    return typeof value === 'string'
        && value.length <= MAX_PAGE_TOKEN_LENGTH
        && (!value || /^[\x21-\x7E]+$/.test(value));
}

function sendFailure(res, status, code, message) {
    res.status(status).json({ success: false, code, message });
}

function isQuotaFailure(payload) {
    const reasons = payload?.error?.errors?.map((error) => error?.reason) || [];
    return reasons.some((reason) => /quota|dailyLimit|rateLimit|resourceExhausted/i.test(String(reason)))
        || /quota|resource exhausted/i.test(String(payload?.error?.status || ''));
}

function readThumbnail(thumbnails, videoId) {
    for (const size of ['maxres', 'high', 'medium', 'default']) {
        const value = thumbnails?.[size]?.url;
        try {
            const url = new URL(value);
            if (url.protocol === 'https:' && url.hostname === 'i.ytimg.com') return url.toString();
        } catch {
            // Use the canonical YouTube thumbnail URL below when an upstream thumbnail is invalid.
        }
    }
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function mapVideo(item) {
    const videoId = item?.id?.videoId;
    const snippet = item?.snippet;
    if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || !snippet) return null;

    return {
        videoId,
        title: String(snippet.title || '').slice(0, 500),
        thumbnailUrl: readThumbnail(snippet.thumbnails, videoId),
        channelName: String(snippet.channelTitle || '').slice(0, 200),
        description: String(snippet.description || '').slice(0, 5000),
        publishedAt: String(snippet.publishedAt || snippet.publishTime || '')
    };
}

function getCachedSearch(cache, key, now) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= now) {
        cache.delete(key);
        return null;
    }
    return cached.data;
}

function storeCachedSearch(cache, key, data, now) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(key, { data, expiresAt: now + CACHE_TTL_MS });
}

export function createYouTubeSearchHandler({
    apiKey = process.env.YOUTUBE_API_KEY,
    fetchImpl = fetch,
    cache = SEARCH_CACHE,
    now = Date.now,
    logger = console
} = {}) {
    return async (req, res) => {
        const rawQuery = req.query.q;
        const query = typeof rawQuery === 'string' ? rawQuery.normalize('NFKC').trim() : '';
        const pageToken = req.query.pageToken === undefined ? '' : req.query.pageToken;
        if (!query || Array.from(query).length > 100 || /[\u0000-\u001F\u007F]/.test(query)) {
            sendFailure(res, 400, 'INVALID_YOUTUBE_QUERY', 'Enter a search query of 1 to 100 characters.');
            return;
        }
        if (!isValidPageToken(pageToken)) {
            sendFailure(res, 400, 'INVALID_YOUTUBE_PAGE_TOKEN', 'The YouTube pagination token is invalid.');
            return;
        }

        const configuredApiKey = String(apiKey || '').trim();
        if (!configuredApiKey) {
            sendFailure(res, 503, 'YOUTUBE_NOT_CONFIGURED', 'YouTube search is not configured on the server yet.');
            return;
        }

        const cacheKey = `${query.toLowerCase()}\n${pageToken}`;
        const cached = getCachedSearch(cache, cacheKey, now());
        if (cached) {
            res.json({ success: true, ...cached });
            return;
        }

        const url = new URL('https://www.googleapis.com/youtube/v3/search');
        url.search = new URLSearchParams({
            key: configuredApiKey,
            part: 'snippet',
            type: 'video',
            videoEmbeddable: 'true',
            maxResults: '12',
            q: query,
            ...(pageToken ? { pageToken } : {})
        }).toString();

        let response;
        try {
            response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
        } catch {
            logger.error(JSON.stringify({ category: 'youtube-search', code: 'UPSTREAM_REQUEST_FAILED' }));
            sendFailure(res, 502, 'YOUTUBE_SEARCH_UNAVAILABLE', 'YouTube search is temporarily unavailable. Please try again.');
            return;
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            logger.error(JSON.stringify({ category: 'youtube-search', code: 'INVALID_UPSTREAM_RESPONSE', status: response.status }));
            sendFailure(res, 502, 'YOUTUBE_SEARCH_UNAVAILABLE', 'YouTube search returned an invalid response. Please try again.');
            return;
        }

        if (!response.ok) {
            if (isQuotaFailure(payload)) {
                sendFailure(res, 429, 'YOUTUBE_QUOTA_EXCEEDED', 'YouTube search has reached its API quota. Please try again later.');
                return;
            }
            logger.error(JSON.stringify({ category: 'youtube-search', code: 'UPSTREAM_API_ERROR', status: response.status }));
            sendFailure(res, 502, 'YOUTUBE_SEARCH_UNAVAILABLE', 'YouTube search is temporarily unavailable. Please try again.');
            return;
        }

        if (!Array.isArray(payload?.items)) {
            logger.error(JSON.stringify({ category: 'youtube-search', code: 'INVALID_UPSTREAM_RESPONSE', status: response.status }));
            sendFailure(res, 502, 'YOUTUBE_SEARCH_UNAVAILABLE', 'YouTube search returned an invalid response. Please try again.');
            return;
        }

        const videos = payload.items.map(mapVideo).filter(Boolean);
        const nextPageToken = isValidPageToken(payload.nextPageToken) ? payload.nextPageToken : '';
        const data = { videos, nextPageToken };
        storeCachedSearch(cache, cacheKey, data, now());
        res.json({ success: true, ...data });
    };
}
