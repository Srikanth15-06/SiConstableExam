import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { pbkdf2 as pbkdf2Callback } from 'node:crypto';
import { promisify } from 'node:util';
import { createAuthenticationRouter, InMemorySessionStore } from './auth-service.mjs';

function createTestStore() {
    const accounts = new Map();
    const records = new Map();
    return {
        async createAccount({ name, email, passwordHash }) {
            if (accounts.has(email)) {
                const error = new Error('duplicate');
                error.code = 'ACCOUNT_EXISTS';
                throw error;
            }
            const user = {
                userId: `usr_${crypto.randomUUID()}`,
                name,
                email,
                passwordHash,
                status: 'active',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastLoginAt: null
            };
            accounts.set(email, user);
            records.set(user.userId, {
                schemaVersion: 1, revision: 0, userId: user.userId, profile: { name, email }, exam: 'SI',
                userProgress: {}, testHistory: [], attempts: [], seenQuestionCount: 0, testAttemptCounter: 0,
                plannerData: { examType: 'SI', generatedAt: null, summary: {}, topicMetrics: [], schedule: [] }
            });
            return publicUser(user);
        },
        async createLegacyAccount({ name, email, passwordHash, userData }) {
            if (accounts.has(email)) throw Object.assign(new Error('duplicate'), { code: 'ACCOUNT_EXISTS' });
            const user = {
                userId: userData.userId, name, email, passwordHash, status: 'active',
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastLoginAt: null
            };
            accounts.set(email, user);
            records.set(user.userId, structuredClone(userData));
            return { user: publicUser(user), data: structuredClone(userData), idempotent: false };
        },
        async findAccountByEmail(email) {
            return accounts.get(email) || null;
        },
        async findAccountById(userId) {
            return [...accounts.values()].find((account) => account.userId === userId) || null;
        },
        async recordLogin(userId) {
            const account = [...accounts.values()].find((entry) => entry.userId === userId);
            account.lastLoginAt = new Date().toISOString();
            return publicUser(account);
        },
        async getUserData(userId) { return structuredClone(records.get(userId)); },
        async getUserDataForLegacyImport(userId) { return structuredClone(records.get(userId) ?? null); },
        async importLegacyUserData(userId, userData, expectedRevision) {
            const existing = records.get(userId);
            if (existing && existing.legacyImport?.fingerprint === userData.legacyImport.fingerprint) {
                return { revision: existing.revision, data: structuredClone(existing), idempotent: true };
            }
            if (existing && (existing.revision !== expectedRevision || existing.revision !== 0)) {
                throw Object.assign(new Error('conflict'), { code: 'LEGACY_IMPORT_CONFLICT' });
            }
            const imported = { ...structuredClone(userData), revision: 1 };
            records.set(userId, imported);
            return { revision: 1, data: structuredClone(imported), idempotent: false };
        },
        records
    };
}

function publicUser(user) {
    const { passwordHash: _passwordHash, ...safe } = user;
    return safe;
}

async function createServer() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '2mb' }));
    const sessions = new InMemorySessionStore({ ttlMs: 60_000 });
    const dataStore = createTestStore();
    app.use('/api', createAuthenticationRouter({
        dataStore,
        sessions,
        allowedOrigins: new Set(['https://frontend.example.test']),
        secureCookies: true
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, dataStore };
}

function authRequest(url, body, cookie) {
    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: 'https://frontend.example.test',
            'X-Forwarded-Proto': 'https',
            ...(cookie ? { Cookie: cookie } : {})
        },
        body: JSON.stringify(body)
    });
}

test('signup, duplicate signup, login, /auth/me, rotation, and logout use safe cookies and responses', async (context) => {
    const { server, baseUrl } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const signup = await authRequest(`${baseUrl}/api/auth/signup`, {
        name: 'Candidate One', email: 'candidate@example.test', password: 'valid-test-password'
    });
    assert.equal(signup.status, 202);
    const signupData = await signup.json();
    assert.equal(signupData.code, 'SIGNUP_ACCEPTED');
    assert.equal(signup.headers.get('set-cookie'), null);

    const duplicate = await authRequest(`${baseUrl}/api/auth/signup`, {
        name: 'Candidate One', email: 'CANDIDATE@example.test', password: 'valid-test-password'
    });
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), signupData);

    const firstLogin = await authRequest(`${baseUrl}/api/auth/login`, {
        email: 'candidate@example.test', password: 'valid-test-password'
    });
    assert.equal(firstLogin.status, 200);
    const firstLoginData = await firstLogin.json();
    const firstCookieHeader = firstLogin.headers.get('set-cookie');
    assert.match(firstCookieHeader, /HttpOnly/i);
    assert.match(firstCookieHeader, /Secure/i);
    assert.match(firstCookieHeader, /SameSite=None/i);
    const firstCookie = firstCookieHeader.split(';')[0];

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: firstCookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.userId, firstLoginData.user.userId);

    const wrongLogin = await authRequest(`${baseUrl}/api/auth/login`, {
        email: 'candidate@example.test', password: 'wrong-password'
    });
    assert.equal(wrongLogin.status, 401);
    assert.equal((await wrongLogin.json()).code, 'INVALID_CREDENTIALS');

    const login = await authRequest(`${baseUrl}/api/auth/login`, {
        email: 'candidate@example.test', password: 'valid-test-password'
    }, firstCookie);
    assert.equal(login.status, 200);
    const secondCookieHeader = login.headers.get('set-cookie');
    const secondCookie = secondCookieHeader.split(';')[0];
    assert.notEqual(secondCookie, firstCookie);

    const oldSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: firstCookie } });
    assert.equal(oldSession.status, 401);
    const newSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: secondCookie } });
    assert.equal(newSession.status, 200);

    const logout = await authRequest(`${baseUrl}/api/auth/logout`, {}, secondCookie);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);
    const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: secondCookie } });
    assert.equal(afterLogout.status, 401);
});

const pbkdf2 = promisify(pbkdf2Callback);

function makeLegacyRecord(email, overrides = {}) {
    return pbkdf2('legacy-password', Buffer.alloc(16, 5), 120_000, 32, 'sha256').then((hash) => ({
        id: 'member_1730000000000_ab12cd',
        name: 'Legacy Candidate',
        email,
        exam: 'SI',
        passwordSalt: Buffer.alloc(16, 5).toString('hex'),
        passwordHash: hash.toString('hex'),
        userProgress: { Percentages: { level: 'Intermediate', bestScore: 8, attempts: 4, accuracy: 75 } },
        testHistory: [],
        seenQuestionCount: 40,
        testAttemptCounter: 4,
        plannerData: { examType: 'SI', generatedAt: null, summary: {}, topicMetrics: [], schedule: [] },
        ...overrides
    }));
}

test('legacy import verifies PBKDF2, upgrades to bcrypt, issues a session, and is idempotent', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const legacyRecord = await makeLegacyRecord('legacy@example.test');
    const request = () => authRequest(`${baseUrl}/api/auth/legacy-import`, { legacyRecord, password: 'legacy-password' });

    const first = await request();
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.match(firstBody.user.userId, /^usr_[a-f\d-]{36}$/i);
    assert.equal(firstBody.user.email, 'legacy@example.test');
    assert.equal('passwordHash' in firstBody.user, false);
    const cookieHeader = first.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /Secure/i);
    assert.match(cookieHeader, /SameSite=None/i);
    const cookie = cookieHeader.split(';')[0];
    const stored = dataStore.records.get(firstBody.user.userId);
    assert.match((await dataStore.findAccountById(firstBody.user.userId)).passwordHash, /^\$2[aby]\$/);
    assert.equal(JSON.stringify(stored).includes(legacyRecord.passwordHash), false);
    assert.equal(stored.userProgress.Percentages, undefined);
    assert.equal(stored.legacyArchive.userProgress.Percentages.verified, false);

    const retry = await fetch(`${baseUrl}/api/auth/legacy-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://frontend.example.test', 'X-Forwarded-Proto': 'https', Cookie: cookie },
        body: JSON.stringify({ legacyRecord, password: 'legacy-password' })
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).idempotent, true);
    assert.equal(dataStore.records.size, 1);
});

test('legacy import rejects wrong passwords and will not import into another or nonempty account', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const legacyRecord = await makeLegacyRecord('owner@example.test');
    const wrongPassword = await authRequest(`${baseUrl}/api/auth/legacy-import`, { legacyRecord, password: 'wrong-password' });
    assert.equal(wrongPassword.status, 401);
    assert.equal(dataStore.records.size, 0);

    const signupUser = async (name, email) => {
        await authRequest(`${baseUrl}/api/auth/signup`, { name, email, password: 'valid-test-password' });
        const response = await authRequest(`${baseUrl}/api/auth/login`, { email, password: 'valid-test-password' });
        const body = await response.json();
        return { user: body.user, cookie: response.headers.get('set-cookie').split(';')[0] };
    };
    const owner = await signupUser('Owner', 'owner@example.test');
    const other = await signupUser('Other', 'other@example.test');
    const crossAccount = await authRequest(`${baseUrl}/api/auth/legacy-import`, { legacyRecord, password: 'legacy-password' }, other.cookie);
    assert.equal(crossAccount.status, 403);
    assert.equal(dataStore.records.get(owner.user.userId).legacyImport, undefined);

    const ownerData = dataStore.records.get(owner.user.userId);
    ownerData.userProgress.Percentages = { attempts: 1 };
    const conflict = await authRequest(`${baseUrl}/api/auth/legacy-import`, { legacyRecord, password: 'legacy-password' }, owner.cookie);
    assert.equal(conflict.status, 409);
    assert.equal(dataStore.records.get(owner.user.userId).userProgress.Percentages.attempts, 1);
});

test('legacy import treats an account with no saved user state as empty rather than conflicting', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const signup = await authRequest(`${baseUrl}/api/auth/signup`, { name: 'Owner', email: 'empty-state@example.test', password: 'valid-test-password' });
    assert.equal(signup.status, 202);
    const login = await authRequest(`${baseUrl}/api/auth/login`, { email: 'empty-state@example.test', password: 'valid-test-password' });
    assert.equal(login.status, 200);
    const { user } = await login.json();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    dataStore.records.set(user.userId, undefined);

    const legacyRecord = await makeLegacyRecord('empty-state@example.test');
    const importResponse = await authRequest(`${baseUrl}/api/auth/legacy-import`, { legacyRecord, password: 'legacy-password' }, cookie);
    assert.equal(importResponse.status, 201);
    const body = await importResponse.json();
    assert.equal(body.success, true);
    assert.equal(body.user.email, 'empty-state@example.test');
    assert.equal(typeof dataStore.records.get(user.userId)?.legacyImport?.fingerprint, 'string');
    assert.equal(dataStore.records.get(user.userId).legacyImport.fingerprint.length, 64);
});

test('legacy import requires HTTPS and trusted origin without modifying legacy data', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const legacyRecord = await makeLegacyRecord('legacy@example.test');
    const insecure = await fetch(`${baseUrl}/api/auth/legacy-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://frontend.example.test' },
        body: JSON.stringify({ legacyRecord, password: 'legacy-password' })
    });
    assert.equal(insecure.status, 400);
    const untrusted = await fetch(`${baseUrl}/api/auth/legacy-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example.test', 'X-Forwarded-Proto': 'https' },
        body: JSON.stringify({ legacyRecord, password: 'legacy-password' })
    });
    assert.equal(untrusted.status, 403);
    assert.equal(dataStore.records.size, 0);
});

test('signup and logout reject missing or untrusted origins', async (context) => {
    const { server, baseUrl } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const denied = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example.test' },
        body: JSON.stringify({ name: 'Candidate', email: 'candidate@example.test', password: 'valid-test-password' })
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'CSRF_ORIGIN_DENIED');
});
