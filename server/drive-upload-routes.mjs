import express from 'express';
import { uploadTopicFile } from './google-drive-service.mjs';

export function createCandidateDriveUploadRouter({ allowedOrigins, requireCandidateSession, rateLimiter, sendFailure, uploadFile = uploadTopicFile }) {
    const router = express.Router();

    router.post('/candidate/folders/:folderId/files', requireCandidateSession, (req, res, next) => {
        const origin = req.get('origin');
        let requestOrigin = '';
        try {
            requestOrigin = origin ? new URL(origin).origin : '';
        } catch {
            requestOrigin = '';
        }
        if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
            res.status(403).json({
                success: false,
                code: 'DRIVE_UPLOAD_ORIGIN_DENIED',
                message: 'This origin cannot upload to the Notes Library.'
            });
            return;
        }
        next();
    }, rateLimiter, express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
        try {
            const file = await uploadFile(
                req.params.folderId,
                String(req.query.parentFolderId || ''),
                String(req.query.name || ''),
                String(req.query.mimeType || ''),
                req.body
            );
            res.status(201).json({ success: true, provider: 'googleDrive', file });
        } catch (error) {
            sendFailure(res, error);
        }
    });

    return router;
}