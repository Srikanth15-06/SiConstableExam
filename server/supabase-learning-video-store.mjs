import { VIDEO_COLUMNS } from './topic-learning-video-routes.mjs';

function mapStoreError(error) {
    if (error?.code === '23505' || error?.code === '23514') {
        return Object.assign(new Error('topic learning video limit reached'), { code: 'TOPIC_VIDEO_LIMIT' });
    }
    return Object.assign(new Error('learning video storage failed'), { code: error?.code || 'SUPABASE_STORAGE_FAILED' });
}

function requireData(result) {
    if (result?.error) throw mapStoreError(result.error);
    return result?.data;
}

function mapVideo(video) {
    return video || null;
}

export function createSupabaseLearningVideoStore(dataStore) {
    return {
        async list({ examType, subject, topic }) {
            const result = await dataStore.getClient()
                .from('topic_learning_videos')
                .select(VIDEO_COLUMNS)
                .eq('exam_type', examType)
                .eq('subject', subject)
                .eq('topic', topic)
                .order('display_order', { ascending: true });
            return requireData(result) || [];
        },
        async create({ examType, subject, topic, title, youtubeUrl, videoId }) {
            const result = await dataStore.getClient()
                .from('topic_learning_videos')
                .insert({
                    exam_type: examType,
                    subject,
                    topic,
                    title,
                    youtube_url: youtubeUrl,
                    youtube_video_id: videoId,
                    display_order: 1
                })
                .select(VIDEO_COLUMNS)
                .single();
            return mapVideo(requireData(result));
        },
        async update(id, { title, youtubeUrl, videoId }) {
            const result = await dataStore.getClient()
                .from('topic_learning_videos')
                .update({ title, youtube_url: youtubeUrl, youtube_video_id: videoId, updated_at: new Date().toISOString() })
                .eq('id', id)
                .select(VIDEO_COLUMNS)
                .maybeSingle();
            const video = requireData(result);
            if (!video) throw Object.assign(new Error('learning video not found'), { code: 'VIDEO_NOT_FOUND' });
            return mapVideo(video);
        },
        async delete(id) {
            const result = await dataStore.getClient()
                .from('topic_learning_videos')
                .delete()
                .eq('id', id)
                .select('id')
                .maybeSingle();
            const removed = requireData(result);
            if (!removed) throw Object.assign(new Error('learning video not found'), { code: 'VIDEO_NOT_FOUND' });
            return true;
        }
    };
}