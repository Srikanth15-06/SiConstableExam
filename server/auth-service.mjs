import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { createLegacyImportId, createLegacyUserData, sanitizeLegacyMember, verifyLegacyPassword, LegacyImportError } from './legacy-import-service.mjs';

export const AUTH_COOKIE_NAME = 'ts_police_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const BCRYPT_ROUNDS = 10;
const DUMMY_PASSWORD_HASH = await bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
const noRateLimit = (_req, _res, next) => next();

function parseCookie(header, name) {
    for (const item of String(header || '').split(';')) {
        const separator = item.indexOf('=');
        if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
        try {
            return decodeURIComponent(item.slice(separator + 1).trim());
        } catch {
            return '';
        }
    }
    return '';
}

function sessionKey(sessionId) {
    return createHash('sha256').update(sessionId).digest('hex');
}

function requestFailure(res, status, code, message) {
    res.status(status).json({ success: false, error: true, code, message });
}

function validEmail(email) {
    return typeof email === 'string' && email.length <= 254 && /^\S+@\S+\.\S+$/.test(email);
}

function sanitizeName(name) {
    return typeof name === 'string' ? name.normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : '';
}

export class InMemorySessionStore {
    constructor({ ttlMs = SESSION_TTL_MS, now = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.sessions = new Map();
    }

    cleanup() {
        const now = this.now();
        for (const [key, session] of this.sessions) {
            if (session.expiresAt <= now) this.sessions.delete(key);
        }
    }

    create(userId) {
        if (typeof userId !== 'string' || !userId.startsWith('usr_')) throw new TypeError('A server-generated user ID is required.');
        this.cleanup();
        const sessionId = randomBytes(32).toString('base64url');
        const expiresAt = this.now() + this.ttlMs;
        this.sessions.set(sessionKey(sessionId), { userId, expiresAt });
        return { sessionId, expiresAt };
    }

    resolve(sessionId) {
        if (!sessionId) return null;
        const key = sessionKey(sessionId);
        const session = this.sessions.get(key);
        if (!session) return null;
        if (session.expiresAt <= this.now()) {
            this.sessions.delete(key);
            return null;
        }
        return { userId: session.userId, expiresAt: session.expiresAt };
    }

    revoke(sessionId) {
        if (!sessionId) return false;
        return this.sessions.delete(sessionKey(sessionId));
    }
}

export function createAuthenticationMiddleware(sessions) {
    return async (req, res, next) => {
        try {
            const sessionId = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
            const session = await sessions.resolve(sessionId);
            if (!session) {
                requestFailure(res, 401, 'AUTH_REQUIRED', 'Sign in to continue.');
                return;
            }
            req.authUserId = session.userId;
            req.authSessionId = sessionId;
            next();
        } catch (error) {
            const requestId = randomUUID();
            console.error(JSON.stringify({ requestId, category: 'session', code: error.code || 'SESSION_STORE_UNAVAILABLE' }));
            requestFailure(res, 503, 'SESSION_STORE_UNAVAILABLE', 'Your session could not be verified. Please retry.');
        }
    };
}

function setSessionCookie(res, sessionId, expiresAt, secure) {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function hasMeaningfulUserData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const planner = data?.plannerData || {};
    const revision = Number(data?.revision);
    return (Number.isFinite(revision) && revision !== 0)
        || Object.keys(data?.userProgress || {}).length > 0
        || (data?.testHistory || []).length > 0
        || (data?.attempts || []).length > 0
        || Number(data?.seenQuestionCount) > 0
        || Number(data?.testAttemptCounter) > 0
        || (planner.schedule || []).length > 0
        || (planner.topicMetrics || []).length > 0
        || Object.keys(planner.summary || {}).length > 0;
}

function legacyImportFailure(res, status, code, message) {
    res.status(status).json({ success: false, error: true, code, message });
}

function clearSessionCookie(res, secure) {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

export function createAuthenticationRouter({ dataStore, sessions, allowedOrigins = new Set(), rateLimiters = {}, secureCookies = false }) {
    const router = Router();
    const authenticate = createAuthenticationMiddleware(sessions);
    const requireTrustedOrigin = (req, res, next) => {
        const origin = req.get('origin');
        let normalizedOrigin = '';
        try {
            normalizedOrigin = origin ? new URL(origin).origin : '';
        } catch {
            normalizedOrigin = '';
        }
        if (!normalizedOrigin || !allowedOrigins.has(normalizedOrigin)) {
            requestFailure(res, 403, 'CSRF_ORIGIN_DENIED', 'This request origin is not allowed. Reload the application and try again.');
            return;
        }
        next();
    };
    const attachOptionalSession = async (req, res, next) => {
        const sessionId = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
        if (!sessionId) {
            next();
            return;
        }
        try {
            const session = await sessions.resolve(sessionId);
            if (session) {
                req.authUserId = session.userId;
                req.authSessionId = sessionId;
            }
            next();
        } catch (error) {
            const requestId = randomUUID();
            console.error(JSON.stringify({ requestId, category: 'session', code: error.code || 'SESSION_STORE_UNAVAILABLE' }));
            legacyImportFailure(res, 503, 'SESSION_STORE_UNAVAILABLE', 'Your session could not be verified. Please retry.');
        }
    };

    router.post('/auth/legacy-import', requireTrustedOrigin, rateLimiters.legacyImport || noRateLimit, attachOptionalSession, async (req, res) => {
        if (secureCookies && !req.secure) {
            legacyImportFailure(res, 400, 'HTTPS_REQUIRED', 'Legacy account import requires a secure connection.');
            return;
        }
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
            || Object.keys(req.body).length !== 2 || !Object.hasOwn(req.body, 'legacyRecord') || !Object.hasOwn(req.body, 'password')) {
            legacyImportFailure(res, 400, 'INVALID_LEGACY_IMPORT', 'The legacy import request is malformed. Your browser copy has not been changed.');
            return;
        }

        let legacy;
        const password = req.body?.password;
        try {
            legacy = sanitizeLegacyMember(req.body?.legacyRecord);
        } catch (error) {
            const failure = error instanceof LegacyImportError ? error : new LegacyImportError('INVALID_LEGACY_RECORD', 'This saved account record is invalid or unsupported.');
            legacyImportFailure(res, failure.status, failure.code, failure.message);
            return;
        }
        if (typeof password !== 'string' || password.length < 1 || password.length > 128) {
            legacyImportFailure(res, 400, 'INVALID_LEGACY_CREDENTIALS', 'Enter the password used by the old account. Your browser copy has not been changed.');
            return;
        }

        try {
            if (!await verifyLegacyPassword(password, legacy.passwordSalt, legacy.passwordHash)) {
                legacyImportFailure(res, 401, 'INVALID_LEGACY_CREDENTIALS', 'The old account password could not be verified. Your browser copy has not been changed.');
                return;
            }

            let account = await dataStore.findAccountByEmail(legacy.email);
            let created = false;
            if (!account) {
                const userId = createLegacyImportId();
                const importedAt = new Date().toISOString();
                const userData = createLegacyUserData(userId, legacy, importedAt);
                const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
                try {
                    const result = await dataStore.createLegacyAccount({
                        name: legacy.name,
                        email: legacy.email,
                        passwordHash,
                        userData,
                        createdAt: importedAt
                    });
                    account = result.user;
                    created = true;
                } catch (error) {
                    if (error.code !== 'ACCOUNT_EXISTS') throw error;
                    account = await dataStore.findAccountByEmail(legacy.email);
                    if (!account) throw error;
                }
            }

            if (account.status !== 'active') {
                legacyImportFailure(res, 401, 'INVALID_LEGACY_CREDENTIALS', 'The old account password could not be verified. Your browser copy has not been changed.');
                return;
            }

            if (!created) {
                let currentData = null;
                try {
                    currentData = dataStore.getUserDataForLegacyImport
                        ? await dataStore.getUserDataForLegacyImport(account.userId)
                        : await dataStore.getUserData(account.userId);
                } catch (error) {
                    if (error.code !== 'USER_DATA_NOT_FOUND') throw error;
                }
                if (currentData && currentData.legacyImport?.fingerprint === legacy.fingerprint) {
                    const user = await dataStore.recordLogin(account.userId);
                    const oldSession = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
                    if (req.authUserId !== account.userId) {
                        await sessions.revoke(oldSession);
                        const session = await sessions.create(user.userId);
                        setSessionCookie(res, session.sessionId, session.expiresAt, secureCookies);
                    }
                    res.json({ success: true, imported: true, idempotent: true, user });
                    return;
                }

                if (!req.authUserId) {
                    legacyImportFailure(res, 409, 'EXISTING_ACCOUNT_SIGN_IN_REQUIRED', 'Sign in to the matching account before importing its saved data. Your browser copy has not been changed.');
                    return;
                }
                if (req.authUserId !== account.userId || account.email.toLowerCase() !== legacy.email) {
                    legacyImportFailure(res, 403, 'LEGACY_ACCOUNT_MISMATCH', 'This browser account does not match the signed-in account. Your browser copy has not been changed.');
                    return;
                }
                if (hasMeaningfulUserData(currentData)) {
                    legacyImportFailure(res, 409, 'LEGACY_IMPORT_CONFLICT', 'This account already has saved server data. Nothing was overwritten. Use account recovery to resolve the conflict.');
                    return;
                }

                const importedAt = new Date().toISOString();
                const userData = createLegacyUserData(account.userId, legacy, importedAt);
                userData.profile = currentData?.profile || userData.profile;
                userData.exam = currentData?.exam || userData.exam;
                const imported = await dataStore.importLegacyUserData(account.userId, userData, currentData ? currentData.revision : 0);
                const user = await dataStore.recordLogin(account.userId);
                res.status(imported.idempotent ? 200 : 201).json({ success: true, imported: true, idempotent: Boolean(imported.idempotent), user });
                return;
            }

            const oldSession = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
            await sessions.revoke(oldSession);
            const session = await sessions.create(account.userId);
            setSessionCookie(res, session.sessionId, session.expiresAt, secureCookies);
            res.status(201).json({ success: true, imported: true, idempotent: false, user: account });
        } catch (error) {
            if (['LEGACY_IMPORT_CONFLICT', 'DATA_CONFLICT'].includes(error.code)) {
                legacyImportFailure(res, 409, 'LEGACY_IMPORT_CONFLICT', 'This account already has saved server data or a different legacy import. Nothing was overwritten.');
                return;
            }
            const requestId = randomUUID();
            console.error(JSON.stringify({ requestId, category: 'legacy-import', code: error.code || 'LEGACY_IMPORT_FAILED' }));
            legacyImportFailure(res, 503, 'LEGACY_IMPORT_UNAVAILABLE', 'The saved account could not be imported right now. Your browser copy has not been changed.');
        }
    });

    router.post('/auth/signup', requireTrustedOrigin, rateLimiters.signup || noRateLimit, async (req, res) => {
        const name = sanitizeName(req.body?.name);
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = req.body?.password;
        if (!name || !validEmail(email) || typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
            requestFailure(res, 400, 'INVALID_SIGNUP', 'Enter a valid name, email, and password of 8 to 128 characters.');
            return;
        }

        try {
            const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
            await dataStore.createAccount({ name, email, passwordHash });
            res.status(202).json({ success: true, code: 'SIGNUP_ACCEPTED', message: 'If this address is available, the account is ready. Sign in to continue; if it already has an account, sign in with that account.' });
        } catch (error) {
            if (error.code === 'ACCOUNT_EXISTS') {
                res.status(202).json({ success: true, code: 'SIGNUP_ACCEPTED', message: 'If this address is available, the account is ready. Sign in to continue; if it already has an account, sign in with that account.' });
                return;
            }
            const requestId = randomUUID();
            console.error(JSON.stringify({ requestId, category: 'auth', code: error.code || 'ACCOUNT_CREATE_FAILED' }));
            requestFailure(res, 503, 'ACCOUNT_STORAGE_UNAVAILABLE', 'Account storage is temporarily unavailable. Please retry.');
        }
    });

    router.post('/auth/login', requireTrustedOrigin, rateLimiters.login || noRateLimit, async (req, res) => {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = req.body?.password;
        if (!validEmail(email) || typeof password !== 'string' || password.length > PASSWORD_MAX_LENGTH) {
            requestFailure(res, 400, 'INVALID_LOGIN_REQUEST', 'Enter a valid email address and password.');
            return;
        }

        try {
            const account = await dataStore.findAccountByEmail(email);
            const accountIsActive = account?.status === 'active' && /^\$2[aby]\$\d\d\$/.test(account.passwordHash || '');
            const passwordMatches = await bcrypt.compare(password, accountIsActive ? account.passwordHash : DUMMY_PASSWORD_HASH).catch(() => false);
            if (!accountIsActive || !passwordMatches) {
                requestFailure(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
                return;
            }
            const user = await dataStore.recordLogin(account.userId);
            const previousSession = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
            await sessions.revoke(previousSession);
            const session = await sessions.create(user.userId);
            setSessionCookie(res, session.sessionId, session.expiresAt, secureCookies);
            res.json({ success: true, user });
        } catch (error) {
            const requestId = randomUUID();
            console.error(JSON.stringify({ requestId, category: 'auth', code: error.code || 'LOGIN_FAILED' }));
            requestFailure(res, 503, 'ACCOUNT_STORAGE_UNAVAILABLE', 'Account storage is temporarily unavailable. Please retry.');
        }
    });

    router.post('/auth/logout', requireTrustedOrigin, async (req, res) => {
        try {
            const sessionId = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
            await sessions.revoke(sessionId);
            clearSessionCookie(res, secureCookies);
            res.json({ success: true, authenticated: false });
        } catch (error) {
            const requestId = randomUUID();
            console.error(JSON.stringify({ requestId, category: 'session', code: error.code || 'SESSION_STORE_UNAVAILABLE' }));
            requestFailure(res, 503, 'SESSION_STORE_UNAVAILABLE', 'Your session could not be closed. Please retry.');
        }
    });

    router.get('/auth/me', authenticate, async (req, res) => {
        try {
            const account = await dataStore.findAccountById(req.authUserId);
            if (!account || account.status !== 'active') {
                await sessions.revoke(req.authSessionId);
                clearSessionCookie(res, secureCookies);
                requestFailure(res, 401, 'AUTH_REQUIRED', 'Sign in to continue.');
                return;
            }
            const { userId, email, name, createdAt, lastLoginAt } = account;
            res.json({ success: true, user: { userId, email, name, createdAt, lastLoginAt } });
        } catch (error) {
            const requestId = randomUUID();
            console.error(JSON.stringify({ requestId, category: 'auth', code: error.code || 'ACCOUNT_READ_FAILED' }));
            requestFailure(res, 503, 'ACCOUNT_STORAGE_UNAVAILABLE', 'Account storage is temporarily unavailable. Please retry.');
        }
    });

    return router;
}
