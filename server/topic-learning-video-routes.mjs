import { Router } from 'express';
import { SUBJECT_TOPICS } from '../frontend/src/syllabus.js';
import { createAuthenticationMiddleware } from './auth-service.mjs';

const VIDEO_COLUMNS = 'id,exam_type,subject,topic,title,youtube_url,youtube_video_id,display_order,created_at,updated_at';
const EXAMS = new Set(['SI', 'CONSTABLE']);
const MAX_VIDEOS_PER_TOPIC = 5;

function sendFailure(res, status, code, message) {
    res.status(status).json({ success: false, code, message });
}

function validTopic(subject, topic) {
    return Object.hasOwn(SUBJECT_TOPICS, subject) && SUBJECT_TOPICS[subject].includes(topic);
}

export function parseYouTubeUrl(value) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host)) return null;

    let videoId = '';
    if (host.endsWith('youtu.be')) {
        videoId = url.pathname.split('/').filter(Boolean)[0] || '';
        if (url.pathname.split('/').filter(Boolean).length !== 1) return null;
    } else if (url.pathname === '/watch') {
        videoId = url.searchParams.get('v') || '';
    } else if (/^\/(?:shorts|embed)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) {
        videoId = url.pathname.split('/')[2] || '';
    }

    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    return { videoId, youtubeUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

function parseVideoInput(body) {
    const examType = String(body?.exam || body?.examType || '').trim().toUpperCase();
    const subject = String(body?.subject || '').trim();
    const topic = String(body?.topic || '').trim();
    const title = typeof body?.title === 'string' ? body.title.normalize('NFKC').trim() : '';
    const youtube = parseYouTubeUrl(body?.youtubeUrl || body?.youtube_url);

    if (!EXAMS.has(examType) || !validTopic(subject, topic) || !title || title.length > 120 || !youtube) return null;
    return { examType, subject, topic, title, ...youtube };
}

function publicVideo(video) {
    return {
        id: video.id,
        exam: video.exam_type || video.examType,
        subject: video.subject,
        topic: video.topic,
        title: video.title,
        youtubeUrl: video.youtube_url || video.youtubeUrl,
        videoId: video.youtube_video_id || video.videoId,
        displayOrder: video.display_order || video.displayOrder
    };
}

function handleStoreError(res, error, operation) {
    if (error?.code === 'TOPIC_VIDEO_LIMIT') {
        sendFailure(res, 409, error.code, 'Maximum 5 learning videos allowed for this topic.');
        return;
    }
    if (error?.code === 'VIDEO_NOT_FOUND') {
        sendFailure(res, 404, error.code, 'The learning video was not found.');
        return;
    }
    console.error(JSON.stringify({ category: 'topic-learning-videos', operation, code: error?.code || 'STORAGE_FAILED' }));
    sendFailure(res, 503, 'LEARNING_VIDEOS_UNAVAILABLE', 'Learning videos are temporarily unavailable. Please try again.');
}

export function createTopicLearningVideoRouter({ dataStore, videoStore, sessions, requireAdmin }) {
    const router = Router();
    const authenticate = createAuthenticationMiddleware(sessions);

    router.get('/learning-videos', authenticate, async (req, res) => {
        const subject = String(req.query.subject || '').trim();
        const topic = String(req.query.topic || '').trim();
        if (!validTopic(subject, topic)) {
            sendFailure(res, 400, 'INVALID_TOPIC', 'Choose a valid syllabus subject and topic.');
            return;
        }

        try {
            const userData = await dataStore.getUserData(req.authUserId);
            const examType = EXAMS.has(userData.exam) ? userData.exam : 'SI';
            const videos = await videoStore.list({ examType, subject, topic });
            res.json({ success: true, videos: videos.map(publicVideo) });
        } catch (error) {
            handleStoreError(res, error, 'candidate-read');
        }
    });

    router.get('/admin/learning-videos', requireAdmin, async (req, res) => {
        const examType = String(req.query.exam || '').trim().toUpperCase();
        const subject = String(req.query.subject || '').trim();
        const topic = String(req.query.topic || '').trim();
        if (!EXAMS.has(examType) || !validTopic(subject, topic)) {
            sendFailure(res, 400, 'INVALID_TOPIC', 'Choose a valid exam, subject, and topic.');
            return;
        }
        try {
            const videos = await videoStore.list({ examType, subject, topic });
            res.json({ success: true, videos: videos.map(publicVideo) });
        } catch (error) {
            handleStoreError(res, error, 'admin-read');
        }
    });

    router.post('/admin/learning-videos', requireAdmin, async (req, res) => {
        const input = parseVideoInput(req.body);
        if (!input) {
            sendFailure(res, 400, 'INVALID_LEARNING_VIDEO', 'Enter a valid topic, video title, and YouTube URL.');
            return;
        }
        try {
            const video = await videoStore.create(input);
            res.status(201).json({ success: true, video: publicVideo(video) });
        } catch (error) {
            handleStoreError(res, error, 'create');
        }
    });

    router.patch('/admin/learning-videos/:id', requireAdmin, async (req, res) => {
        const title = typeof req.body?.title === 'string' ? req.body.title.normalize('NFKC').trim() : '';
        const youtube = parseYouTubeUrl(req.body?.youtubeUrl || req.body?.youtube_url);
        if (!/^[a-f\d-]{36}$/i.test(req.params.id) || !title || title.length > 120 || !youtube) {
            sendFailure(res, 400, 'INVALID_LEARNING_VIDEO', 'Enter a valid video title and YouTube URL.');
            return;
        }
        try {
            const video = await videoStore.update(req.params.id, { title, ...youtube });
            res.json({ success: true, video: publicVideo(video) });
        } catch (error) {
            handleStoreError(res, error, 'update');
        }
    });

    router.delete('/admin/learning-videos/:id', requireAdmin, async (req, res) => {
        if (!/^[a-f\d-]{36}$/i.test(req.params.id)) {
            sendFailure(res, 400, 'INVALID_LEARNING_VIDEO', 'The learning video identifier is invalid.');
            return;
        }
        try {
            await videoStore.delete(req.params.id);
            res.json({ success: true });
        } catch (error) {
            handleStoreError(res, error, 'delete');
        }
    });

    return router;
}

export { MAX_VIDEOS_PER_TOPIC, VIDEO_COLUMNS };