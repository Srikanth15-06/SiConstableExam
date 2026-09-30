import { createHash, randomBytes } from 'node:crypto';
import { SESSION_TTL_MS } from './auth-service.mjs';
import { getSupabaseClient } from './supabase-client.mjs';

function hashSession(sessionId) {
    return createHash('sha256').update(String(sessionId || '')).digest('hex');
}

function throwSessionError(error) {
    const failure = new Error('The session store is temporarily unavailable.');
    failure.code = error?.code || 'SESSION_STORE_UNAVAILABLE';
    throw failure;
}

export class SupabaseSessionStore {
    constructor({ supabase = null, ttlMs = SESSION_TTL_MS, now = Date.now, randomToken = () => randomBytes(32).toString('base64url') } = {}) {
        this.supabase = supabase;
        this.ttlMs = ttlMs;
        this.now = now;
        this.randomToken = randomToken;
    }

    getClient() {
        if (!this.supabase) this.supabase = getSupabaseClient();
        return this.supabase;
    }

    async create(userId) {
        if (typeof userId !== 'string' || !userId.startsWith('usr_')) throw new TypeError('A server-generated user ID is required.');
        const sessionId = this.randomToken();
        const expiresAt = this.now() + this.ttlMs;
        const { error } = await this.getClient().from('app_sessions').insert({
            user_id: userId,
            token_hash: hashSession(sessionId),
            expires_at: new Date(expiresAt).toISOString()
        });
        if (error) throwSessionError(error);
        return { sessionId, expiresAt };
    }

    async resolve(sessionId) {
        if (!sessionId) return null;
        const tokenHash = hashSession(sessionId);
        const { data, error } = await this.getClient()
            .from('app_sessions')
            .select('user_id,expires_at')
            .eq('token_hash', tokenHash)
            .maybeSingle();
        if (error) throwSessionError(error);
        if (!data) return null;
        const expiresAt = Date.parse(data.expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
            await this.revoke(sessionId);
            return null;
        }
        return { userId: data.user_id, expiresAt };
    }

    async revoke(sessionId) {
        if (!sessionId) return false;
        const { error } = await this.getClient().from('app_sessions').delete().eq('token_hash', hashSession(sessionId));
        if (error) throwSessionError(error);
        return true;
    }
}