import { randomUUID } from 'node:crypto';
import { getSupabaseClient } from './supabase-client.mjs';

const MAX_WRITE_RETRIES = 4;
const ACCOUNT_COLUMNS = 'id,username,email,password_hash,status,created_at,updated_at,last_login_at';

function storeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function mapAccount(account) {
    if (!account) return null;
    return {
        userId: account.id,
        name: account.username,
        email: account.email,
        passwordHash: account.password_hash,
        status: account.status,
        createdAt: account.created_at,
        updatedAt: account.updated_at,
        lastLoginAt: account.last_login_at
    };
}

function publicAccount(account) {
    if (!account) return null;
    const { userId, name, email, status, createdAt, updatedAt, lastLoginAt } = account;
    return { userId, name, email, status, createdAt, updatedAt, lastLoginAt };
}

function createDefaultUserData(userId, name, email, now) {
    return {
        schemaVersion: 1,
        revision: 0,
        userId,
        plannerRevision: 0,
        profile: { name, email },
        exam: 'SI',
        userProgress: {},
        testHistory: [],
        attempts: [],
        seenQuestionCount: 0,
        testAttemptCounter: 0,
        plannerData: {
            examType: 'SI',
            generatedAt: null,
            summary: {},
            topicMetrics: [],
            schedule: []
        },
        createdAt: now,
        updatedAt: now
    };
}

function requireResult(result, fallbackCode = 'SUPABASE_STORAGE_FAILED') {
    if (!result?.error) return result?.data;
    const error = result.error;
    if (error.code === '23505') throw storeError('ACCOUNT_EXISTS', 'Unable to create this account. Sign in or use another email address.');
    if (error.code === 'P0002') throw storeError('USER_DATA_NOT_FOUND', 'Account data is unavailable.');
    if (error.code === '40001' || error.code === 'DATA_CONFLICT') throw storeError('DATA_CONFLICT', 'Your saved data changed elsewhere. Reload and retry.');
    throw storeError(error.code || fallbackCode, 'Supabase could not complete the data request.');
}

export class SupabaseDataStore {
    constructor({ supabase = null, now = () => new Date(), uuid = randomUUID } = {}) {
        this.supabase = supabase;
        this.now = now;
        this.uuid = uuid;
    }

    getClient() {
        if (!this.supabase) this.supabase = getSupabaseClient();
        return this.supabase;
    }

    async createAccount({ name, email, passwordHash, userId, status = 'active', createdAt }) {
        const username = String(name || '').normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
        const normalizedEmail = normalizeEmail(email);
        if (!username || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
            throw storeError('INVALID_ACCOUNT', 'Provide a valid name and email address.');
        }
        if (!['active', 'disabled'].includes(status)) throw storeError('INVALID_ACCOUNT', 'The account status is invalid.');
        if (!/^\$2[aby]\$\d\d\$/.test(String(passwordHash || ''))) {
            throw storeError('INVALID_ACCOUNT', 'A bcrypt password hash is required.');
        }

        const accountId = userId || `usr_${this.uuid()}`;
        if (!/^usr_[a-f\d-]{36}$/i.test(accountId)) throw storeError('INVALID_ACCOUNT', 'The account identifier is invalid.');
        const timestamp = createdAt || this.now().toISOString();
        const userData = createDefaultUserData(accountId, username, normalizedEmail, timestamp);
        const account = requireResult(await this.getClient().rpc('create_app_account', {
            p_user_id: accountId,
            p_username: username,
            p_email: normalizedEmail,
            p_password_hash: passwordHash,
            p_status: status,
            p_created_at: timestamp,
            p_user_data: userData
        }));
        return publicAccount(mapAccount(account));
    }

    async createLegacyAccount({ name, email, passwordHash, userData, createdAt }) {
        const username = String(name || '').normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
        const normalizedEmail = normalizeEmail(email);
        const userId = String(userData?.userId || '');
        if (!username || !/^\S+@\S+\.\S+$/.test(normalizedEmail)
            || !/^\$2[aby]\$\d\d\$/.test(String(passwordHash || ''))
            || !/^usr_[a-f\d-]{36}$/i.test(userId)
            || userData?.profile?.email !== normalizedEmail || userData?.profile?.name !== username
            || userData?.legacyImport?.version !== 1 || !/^[a-f\d]{64}$/i.test(userData.legacyImport.fingerprint || '')) {
            throw storeError('INVALID_LEGACY_IMPORT', 'The legacy account import is invalid.');
        }

        const timestamp = createdAt || this.now().toISOString();
        const result = requireResult(await this.getClient().rpc('create_app_account_from_legacy', {
            p_user_id: userId,
            p_username: username,
            p_email: normalizedEmail,
            p_password_hash: passwordHash,
            p_created_at: timestamp,
            p_user_data: userData
        }));
        if (!result?.account || !result?.data || result.data.userId !== userId) {
            throw storeError('SUPABASE_DATA_CORRUPT', 'Supabase returned invalid imported account data.');
        }
        return {
            user: publicAccount(mapAccount(result.account)),
            data: result.data,
            idempotent: Boolean(result.idempotent)
        };
    }

    async importLegacyUserData(userId, userData, expectedRevision = 0) {
        if (!/^usr_[a-f\d-]{36}$/i.test(String(userId || '')) || userData?.userId !== userId
            || !Number.isInteger(expectedRevision) || expectedRevision !== 0
            || userData?.legacyImport?.version !== 1 || !/^[a-f\d]{64}$/i.test(userData.legacyImport.fingerprint || '')) {
            throw storeError('INVALID_LEGACY_IMPORT', 'The legacy account import is invalid.');
        }
        const result = await this.getClient().rpc('import_app_user_legacy_state', {
            p_user_id: userId,
            p_expected_revision: expectedRevision,
            p_user_data: userData
        });
        if (result.error?.code === '40001' || result.error?.code === '23505') {
            throw storeError('LEGACY_IMPORT_CONFLICT', 'This account already has saved data or a different legacy import. Nothing was overwritten.');
        }
        const saved = requireResult(result);
        if (!saved?.data || saved.data.userId !== userId) {
            throw storeError('SUPABASE_DATA_CORRUPT', 'Supabase returned invalid imported account data.');
        }
        return { ...saved, revision: Number(saved.revision) || 0 };
    }

    async getUserDataForLegacyImport(userId) {
        const { data, error } = await this.getClient()
            .from('app_user_state')
            .select('data,revision')
            .eq('user_id', String(userId || ''))
            .maybeSingle();
        if (error) requireResult({ error });
        if (!data) return null;

        const revision = Number(data.revision) || 0;
        if (data.data === null || data.data === undefined) return { revision };
        if (typeof data.data !== 'object' || Array.isArray(data.data)) {
            throw storeError('SUPABASE_DATA_CORRUPT', 'Stored account data failed validation.');
        }
        return { ...data.data, revision };
    }

    async findAccountByEmail(email) {
        const { data, error } = await this.getClient()
            .from('app_users')
            .select(ACCOUNT_COLUMNS)
            .eq('email', normalizeEmail(email))
            .maybeSingle();
        if (error) requireResult({ error });
        return mapAccount(data);
    }

    async findAccountById(userId) {
        const { data, error } = await this.getClient()
            .from('app_users')
            .select(ACCOUNT_COLUMNS)
            .eq('id', String(userId || ''))
            .maybeSingle();
        if (error) requireResult({ error });
        return mapAccount(data);
    }

    async recordLogin(userId) {
        const account = requireResult(await this.getClient().rpc('record_app_login', {
            p_user_id: String(userId || ''),
            p_logged_in_at: this.now().toISOString()
        }));
        return publicAccount(mapAccount(account));
    }

    async updateProfile(userId, { name, exam }) {
        const username = String(name || '').normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
        if (!username || !['SI', 'CONSTABLE'].includes(exam)) {
            throw storeError('INVALID_ACCOUNT_PROFILE', 'The account profile update is invalid.');
        }
        const account = requireResult(await this.getClient().rpc('update_app_profile', {
            p_user_id: String(userId || ''),
            p_username: username,
            p_exam: exam,
            p_updated_at: this.now().toISOString()
        }));
        return publicAccount(mapAccount(account));
    }

    async getUserData(userId) {
        const { data, error } = await this.getClient()
            .from('app_user_state')
            .select('data,revision')
            .eq('user_id', String(userId || ''))
            .maybeSingle();
        if (error) requireResult({ error });
        if (!data) throw storeError('USER_DATA_NOT_FOUND', 'Account data is unavailable.');
        if (!data.data || data.data.userId !== userId) throw storeError('SUPABASE_DATA_CORRUPT', 'Stored account data failed validation.');
        return { ...data.data, revision: Number(data.revision) || 0 };
    }

    async updateUserData(userId, update) {
        for (let retry = 0; retry < MAX_WRITE_RETRIES; retry += 1) {
            const current = await this.getUserData(userId);
            const next = await update(structuredClone(current));
            if (!next || typeof next !== 'object' || Array.isArray(next) || next.userId !== userId) {
                throw storeError('INVALID_USER_DATA', 'The application produced invalid account data.');
            }
            const revision = Number(current.revision) || 0;
            next.schemaVersion = 1;
            next.revision = revision + 1;
            next.updatedAt = this.now().toISOString();

            const result = await this.getClient().rpc('commit_app_user_state', {
                p_user_id: userId,
                p_expected_revision: revision,
                p_data: next
            });
            if (result.error && ['40001', 'DATA_CONFLICT'].includes(result.error.code) && retry < MAX_WRITE_RETRIES - 1) continue;
            const saved = requireResult(result);
            if (!saved || !saved.data || saved.data.userId !== userId) {
                throw storeError('SUPABASE_DATA_CORRUPT', 'Supabase returned invalid account data.');
            }
            return { ...saved.data, revision: Number(saved.revision) || revision + 1 };
        }
        throw storeError('DATA_CONFLICT', 'Account data changed repeatedly. Retry the request.');
    }

    async checkHealth() {
        const { error } = await this.getClient()
            .from('app_users')
            .select('id', { head: true, count: 'exact' })
            .limit(1);
        if (error) throw storeError('SUPABASE_UNAVAILABLE', 'Supabase is unreachable.');
        return true;
    }
}