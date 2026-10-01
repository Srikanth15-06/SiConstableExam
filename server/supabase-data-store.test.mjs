import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SupabaseDataStore } from './supabase-data-store.mjs';
import { SupabaseSessionStore } from './supabase-session-store.mjs';

function createFakeSupabase() {
    const users = new Map();
    const state = new Map();
    const sessions = new Map();
    let conflictCount = 0;

    const matches = (row, filters) => [...filters].every(([key, value]) => row?.[key] === value);

    class Query {
        constructor(table) {
            this.table = table;
            this.filters = new Map();
            this.action = 'select';
            this.payload = null;
        }

        select() { return this; }
        limit() { return this; }
        eq(key, value) { this.filters.set(key, value); return this; }
        insert(payload) { this.action = 'insert'; this.payload = payload; return this; }
        update(payload) { this.action = 'update'; this.payload = payload; return this; }
        delete() { this.action = 'delete'; return this; }

        async maybeSingle() {
            const result = await this.execute();
            return { ...result, data: Array.isArray(result.data) ? result.data[0] || null : result.data };
        }

        async execute() {
            const table = this.table === 'app_users' ? users : this.table === 'app_user_state' ? state : sessions;
            const rows = [...table.values()].filter((row) => matches(row, this.filters));
            if (this.action === 'select') return { data: rows, error: null };
            if (this.action === 'insert') {
                const records = Array.isArray(this.payload) ? this.payload : [this.payload];
                for (const record of records) table.set(record.token_hash || record.id || record.user_id, structuredClone(record));
                return { data: null, error: null };
            }
            if (this.action === 'update') {
                for (const row of rows) Object.assign(row, structuredClone(this.payload));
                return { data: rows, error: null };
            }
            if (this.action === 'delete') {
                for (const row of rows) table.delete(row.token_hash || row.id || row.user_id);
                return { data: null, error: null };
            }
            return { data: null, error: { code: 'UNSUPPORTED_QUERY' } };
        }

        then(resolve, reject) { return this.execute().then(resolve, reject); }
    }

    return {
        users,
        state,
        sessions,
        setConflicts(count) { conflictCount = count; },
        from(table) { return new Query(table); },
        async rpc(name, args) {
            if (name === 'create_app_account') {
                if ([...users.values()].some((user) => user.email === args.p_email)) {
                    return { data: null, error: { code: '23505' } };
                }
                const createdAt = args.p_created_at;
                const account = {
                    id: args.p_user_id,
                    username: args.p_username,
                    email: args.p_email,
                    password_hash: args.p_password_hash,
                    status: args.p_status,
                    created_at: createdAt,
                    updated_at: createdAt,
                    last_login_at: null
                };
                users.set(account.id, account);
                state.set(account.id, { user_id: account.id, revision: 0, data: structuredClone(args.p_user_data) });
                return { data: structuredClone(account), error: null };
            }
            if (name === 'record_app_login') {
                const account = users.get(args.p_user_id);
                if (!account) return { data: null, error: { code: 'P0002' } };
                account.last_login_at = args.p_logged_in_at;
                return { data: structuredClone(account), error: null };
            }
            if (name === 'update_app_profile') {
                const account = users.get(args.p_user_id);
                const record = state.get(args.p_user_id);
                if (!account || !record) return { data: null, error: { code: 'P0002' } };
                account.username = args.p_username;
                account.exam_type = args.p_exam;
                record.revision += 1;
                record.data.profile.name = args.p_username;
                record.data.exam = args.p_exam;
                record.data.revision = record.revision;
                record.data.plannerData.examType = args.p_exam;
                return { data: structuredClone(account), error: null };
            }
            if (name === 'commit_app_user_state') {
                if (conflictCount > 0) {
                    conflictCount -= 1;
                    return { data: null, error: { code: '40001' } };
                }
                const record = state.get(args.p_user_id);
                if (!record) return { data: null, error: { code: 'P0002' } };
                if (record.revision !== args.p_expected_revision) return { data: null, error: { code: '40001' } };
                record.revision += 1;
                record.data = structuredClone(args.p_data);
                record.data.revision = record.revision;
                return { data: structuredClone(record), error: null };
            }
            if (name === 'create_app_account_from_legacy') {
                if ([...users.values()].some((user) => user.email === args.p_email)) return { data: null, error: { code: '23505' } };
                const account = {
                    id: args.p_user_id,
                    username: args.p_username,
                    email: args.p_email,
                    password_hash: args.p_password_hash,
                    status: 'active',
                    created_at: args.p_created_at,
                    updated_at: args.p_created_at,
                    last_login_at: null
                };
                users.set(account.id, account);
                state.set(account.id, { user_id: account.id, revision: 0, data: structuredClone(args.p_user_data) });
                return { data: { account: structuredClone(account), data: structuredClone(args.p_user_data), idempotent: false }, error: null };
            }
            if (name === 'import_app_user_legacy_state') {
                const account = users.get(args.p_user_id);
                if (!account) return { data: null, error: { code: 'P0002' } };
                if (String(args.p_user_data.profile?.email || '').toLowerCase() !== account.email.toLowerCase()) {
                    return { data: null, error: { code: '22023' } };
                }
                const record = state.get(args.p_user_id);
                const currentData = record?.data && typeof record.data === 'object' && !Array.isArray(record.data)
                    ? record.data
                    : {};
                const currentRevision = record?.revision ?? 0;
                const oldFingerprint = currentData.legacyImport?.fingerprint;
                const newFingerprint = args.p_user_data.legacyImport.fingerprint;
                if (oldFingerprint !== undefined) {
                    if (oldFingerprint === newFingerprint) {
                        return { data: { revision: currentRevision, data: structuredClone(currentData), idempotent: true }, error: null };
                    }
                    return { data: null, error: { code: '23505' } };
                }
                const planner = currentData.plannerData || {};
                const meaningful = currentRevision !== 0
                    || Object.keys(currentData.userProgress || {}).length > 0
                    || (currentData.testHistory || []).length > 0
                    || (currentData.attempts || []).length > 0
                    || Number(currentData.seenQuestionCount) > 0
                    || Number(currentData.testAttemptCounter) > 0
                    || (planner.schedule || []).length > 0
                    || (planner.topicMetrics || []).length > 0
                    || Object.keys(planner.summary || {}).length > 0;
                if (args.p_expected_revision !== 0 || meaningful) {
                    return { data: null, error: { code: '40001' } };
                }
                const imported = structuredClone(args.p_user_data);
                imported.revision = 1;
                state.set(args.p_user_id, { user_id: args.p_user_id, revision: 1, data: imported });
                return { data: { revision: 1, data: structuredClone(imported), idempotent: false }, error: null };
            }
            return { data: null, error: { code: 'UNSUPPORTED_RPC' } };
        }
    };
}

const passwordHash = '$2b$10$test-only-bcrypt-hash';

test('Supabase accounts and user state persist across data-store instances without exposing hashes', async () => {
    const supabase = createFakeSupabase();
    const firstStore = new SupabaseDataStore({ supabase });
    const account = await firstStore.createAccount({ name: 'Candidate A', email: 'A@example.test', passwordHash });
    assert.match(account.userId, /^usr_[a-f\d-]{36}$/i);
    assert.equal(account.email, 'a@example.test');
    assert.equal('passwordHash' in account, false);

    await firstStore.updateUserData(account.userId, (data) => {
        data.userProgress.Percentages = { subject: 'Arithmetic', topic: 'Percentages', attempts: 15, correctAnswers: 75, totalQuestions: 150, accuracy: 50 };
        data.testHistory = [{ attemptId: randomUUID(), exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', accuracy: 50 }];
        return data;
    });

    const restartedStore = new SupabaseDataStore({ supabase });
    const restoredAccount = await restartedStore.findAccountByEmail('A@EXAMPLE.TEST');
    const restoredData = await restartedStore.getUserData(account.userId);
    assert.equal(restoredAccount.userId, account.userId);
    assert.equal(restoredAccount.passwordHash, passwordHash);
    assert.equal(restoredData.userProgress.Percentages.totalQuestions, 150);
    assert.equal(restoredData.testHistory.length, 1);
    assert.equal(restoredData.revision, 1);
});

test('Supabase state updates retry revision conflicts and isolate users', async () => {
    const supabase = createFakeSupabase();
    const store = new SupabaseDataStore({ supabase });
    const accountA = await store.createAccount({ name: 'Candidate A', email: 'a@example.test', passwordHash });
    const accountB = await store.createAccount({ name: 'Candidate B', email: 'b@example.test', passwordHash });
    supabase.setConflicts(1);

    await store.updateUserData(accountA.userId, (data) => {
        data.testHistory = Array.from({ length: 15 }, (_, index) => ({ attemptId: `a-${index}`, accuracy: 50 }));
        return data;
    });
    await store.updateUserData(accountB.userId, (data) => {
        data.testHistory = Array.from({ length: 50 }, (_, index) => ({ attemptId: `b-${index}`, accuracy: 80 }));
        return data;
    });

    const dataA = await store.getUserData(accountA.userId);
    const dataB = await store.getUserData(accountB.userId);
    assert.equal(dataA.testHistory.length, 15);
    assert.equal(dataA.testHistory.reduce((sum, attempt) => sum + attempt.accuracy, 0) / dataA.testHistory.length, 50);
    assert.equal(dataA.testHistory.some((attempt) => attempt.attemptId.startsWith('b-')), false);
    assert.equal(dataB.testHistory.length, 50);
    assert.equal(dataB.testHistory.reduce((sum, attempt) => sum + attempt.accuracy, 0) / dataB.testHistory.length, 80);
    assert.equal(dataB.testHistory.some((attempt) => attempt.attemptId.startsWith('a-')), false);
});

test('Supabase account lookup passes untrusted email as a bound query value', async () => {
    const supabase = createFakeSupabase();
    const queried = [];
    const originalFrom = supabase.from.bind(supabase);
    supabase.from = (table) => {
        const query = originalFrom(table);
        const originalEq = query.eq.bind(query);
        query.eq = (key, value) => { queried.push({ key, value }); return originalEq(key, value); };
        return query;
    };
    await new SupabaseDataStore({ supabase }).findAccountByEmail("x' OR true --@example.test");
    assert.deepEqual(queried, [{ key: 'email', value: "x' or true --@example.test" }]);
});

test('Supabase sessions persist only token hashes, expire, and revoke across store instances', async () => {
    const supabase = createFakeSupabase();
    let now = 10_000;
    const store = new SupabaseSessionStore({ supabase, ttlMs: 100, now: () => now, randomToken: () => 'opaque-session-token' });
    assert.equal(await store.resolve('invalid-session'), null);
    const created = await store.create('usr_00000000-0000-0000-0000-000000000001');
    assert.equal(supabase.sessions.has('opaque-session-token'), false);
    assert.equal(supabase.sessions.size, 1);
    const hash = [...supabase.sessions.keys()][0];
    assert.match(hash, /^[a-f\d]{64}$/);

    const restartedStore = new SupabaseSessionStore({ supabase, ttlMs: 100, now: () => now });
    assert.deepEqual(await restartedStore.resolve(created.sessionId), {
        userId: 'usr_00000000-0000-0000-0000-000000000001', expiresAt: 10_100
    });
    now = 10_101;
    assert.equal(await restartedStore.resolve(created.sessionId), null);
    assert.equal(supabase.sessions.size, 0);
});

test('Supabase legacy import state reader returns absent and empty states without masking malformed data', async () => {
    const supabase = createFakeSupabase();
    const store = new SupabaseDataStore({ supabase });
    const account = await store.createAccount({ name: 'Candidate', email: 'empty-reader@example.test', passwordHash });

    supabase.state.delete(account.userId);
    assert.equal(await store.getUserDataForLegacyImport(account.userId), null);
    supabase.state.set(account.userId, { user_id: account.userId, revision: 0, data: {} });
    assert.deepEqual(await store.getUserDataForLegacyImport(account.userId), { revision: 0 });
    supabase.state.set(account.userId, { user_id: account.userId, revision: 0, data: null });
    assert.deepEqual(await store.getUserDataForLegacyImport(account.userId), { revision: 0 });
    supabase.state.set(account.userId, { user_id: account.userId, revision: 0, data: 'corrupt' });
    await assert.rejects(store.getUserDataForLegacyImport(account.userId), (error) => error.code === 'SUPABASE_DATA_CORRUPT');
});

test('Supabase legacy account creation stores bcrypt and archived state atomically without exposing hashes', async () => {
    const supabase = createFakeSupabase();
    const store = new SupabaseDataStore({ supabase });
    const userId = `usr_${randomUUID()}`;
    const userData = {
        userId,
        profile: { name: 'Legacy Candidate', email: 'legacy@example.test' },
        exam: 'SI',
        legacyImport: { version: 1, fingerprint: 'a'.repeat(64), importedAt: '2026-09-30T00:00:00.000Z' },
        legacyArchive: { verified: false, userProgress: {}, testHistory: [] },
        userProgress: {}, testHistory: [], attempts: [], plannerData: { examType: 'SI', schedule: [] }
    };
    const result = await store.createLegacyAccount({
        name: 'Legacy Candidate', email: 'LEGACY@example.test', passwordHash,
        userData, createdAt: '2026-09-30T00:00:00.000Z'
    });

    assert.equal(result.user.userId, userId);
    assert.equal(result.user.email, 'legacy@example.test');
    assert.equal('passwordHash' in result.user, false);
    assert.equal(supabase.users.get(userId).password_hash, passwordHash);
    assert.deepEqual(supabase.state.get(userId).data.legacyArchive, userData.legacyArchive);
});

test('Supabase legacy state import creates missing state for an existing empty account', async () => {
    const supabase = createFakeSupabase();
    const store = new SupabaseDataStore({ supabase });
    const account = await store.createAccount({ name: 'Existing Candidate', email: 'missing-state@example.test', passwordHash });
    const importedData = {
        userId: account.userId,
        profile: { name: account.name, email: account.email },
        exam: 'SI',
        legacyImport: { version: 1, fingerprint: 'd'.repeat(64), importedAt: '2026-09-30T00:00:00.000Z' },
        legacyArchive: { verified: false, userProgress: {}, testHistory: [] },
        userProgress: {}, testHistory: [], attempts: [], plannerData: { examType: 'SI', schedule: [] }
    };
    supabase.state.delete(account.userId);

    const result = await store.importLegacyUserData(account.userId, importedData);

    assert.equal(result.revision, 1);
    assert.equal(result.idempotent, false);
    assert.equal(supabase.state.get(account.userId).data.legacyImport.fingerprint, 'd'.repeat(64));
    assert.equal(supabase.state.size, 1);
    assert.equal(supabase.users.size, 1);
});

test('Supabase legacy state import accepts an existing empty JSON state object', async () => {
    const supabase = createFakeSupabase();
    const store = new SupabaseDataStore({ supabase });
    const account = await store.createAccount({ name: 'Existing Candidate', email: 'empty-state@example.test', passwordHash });
    const importedData = {
        userId: account.userId,
        profile: { name: account.name, email: account.email },
        exam: 'SI',
        legacyImport: { version: 1, fingerprint: 'e'.repeat(64), importedAt: '2026-09-30T00:00:00.000Z' },
        legacyArchive: { verified: false, userProgress: {}, testHistory: [] },
        userProgress: {}, testHistory: [], attempts: [], plannerData: { examType: 'SI', schedule: [] }
    };
    supabase.state.set(account.userId, { user_id: account.userId, revision: 0, data: {} });

    const result = await store.importLegacyUserData(account.userId, importedData);

    assert.equal(result.revision, 1);
    assert.equal(result.idempotent, false);
    assert.equal(supabase.state.get(account.userId).data.legacyImport.fingerprint, 'e'.repeat(64));
});

test('Supabase legacy state import conflicts on meaningful state even at revision zero', async () => {
    const supabase = createFakeSupabase();
    const store = new SupabaseDataStore({ supabase });
    const account = await store.createAccount({ name: 'Existing Candidate', email: 'meaningful-state@example.test', passwordHash });
    const importedData = {
        userId: account.userId,
        profile: { name: account.name, email: account.email },
        exam: 'SI',
        legacyImport: { version: 1, fingerprint: 'f'.repeat(64), importedAt: '2026-09-30T00:00:00.000Z' },
        legacyArchive: { verified: false, userProgress: {}, testHistory: [] },
        userProgress: {}, testHistory: [], attempts: [], plannerData: { examType: 'SI', schedule: [] }
    };
    supabase.state.get(account.userId).data.userProgress.Percentages = { attempts: 1 };

    await assert.rejects(store.importLegacyUserData(account.userId, importedData), (error) => error.code === 'LEGACY_IMPORT_CONFLICT');
    assert.equal(supabase.state.get(account.userId).data.userProgress.Percentages.attempts, 1);
    assert.equal(supabase.state.get(account.userId).data.legacyImport, undefined);
});

test('Supabase legacy state import is idempotent and refuses revision conflicts or another user ID', async () => {
    const supabase = createFakeSupabase();
    const store = new SupabaseDataStore({ supabase });
    const account = await store.createAccount({ name: 'Existing Candidate', email: 'existing@example.test', passwordHash });
    const importedData = {
        userId: account.userId,
        profile: { name: 'Existing Candidate', email: 'existing@example.test' },
        exam: 'SI',
        legacyImport: { version: 1, fingerprint: 'b'.repeat(64), importedAt: '2026-09-30T00:00:00.000Z' },
        legacyArchive: { verified: false, userProgress: {}, testHistory: [] },
        userProgress: {}, testHistory: [], attempts: [], plannerData: { examType: 'SI', schedule: [] }
    };
    const first = await store.importLegacyUserData(account.userId, importedData);
    const replay = await store.importLegacyUserData(account.userId, importedData);
    assert.equal(first.revision, 1);
    assert.equal(first.idempotent, false);
    assert.equal(replay.idempotent, true);
    assert.equal(supabase.state.size, 1);
    assert.equal(supabase.users.size, 1);

    await store.updateUserData(account.userId, (data) => ({ ...data, testHistory: [{ id: 'newer-server-data' }] }));
    await assert.rejects(store.importLegacyUserData(account.userId, {
        ...importedData,
        legacyImport: { ...importedData.legacyImport, fingerprint: 'c'.repeat(64) }
    }), (error) => error.code === 'LEGACY_IMPORT_CONFLICT');
    await assert.rejects(store.importLegacyUserData(`usr_${randomUUID()}`, importedData), (error) => error.code === 'INVALID_LEGACY_IMPORT');
});

test('Supabase migration defines isolated application tables and server-only atomic RPCs', async () => {
    const migration = await readFile(new URL('../supabase/migrations/202609290001_initial_schema.sql', import.meta.url), 'utf8');
    for (const table of ['app_users', 'app_sessions', 'app_user_state', 'user_progress', 'quiz_attempts', 'planner_documents', 'user_history', 'user_notes', 'drive_oauth_tokens']) {
        assert.match(migration, new RegExp(`create table if not exists public\\.${table}\\b`, 'i'));
        assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    }
    for (const functionName of ['create_app_account', 'record_app_login', 'update_app_profile', 'commit_app_user_state', 'create_app_account_from_legacy', 'import_app_user_legacy_state']) {
        assert.match(migration, new RegExp(`create or replace function public\\.${functionName}\\b`, 'i'));
        assert.match(migration, new RegExp(`grant execute on function public\\.${functionName}\\b`, 'i'));
    }
    assert.match(migration, /unique index if not exists quiz_attempts_idempotency_unique/i);
    assert.match(migration, /references public\.app_users\(id\) on delete cascade/i);
    assert.equal(/\bexecute\s+format\b/i.test(migration), false);

    const importFunctionStart = migration.indexOf('create or replace function public.import_app_user_legacy_state(');
    const importFunctionEnd = migration.indexOf('$$;', migration.indexOf('as $$', importFunctionStart));
    const importFunction = migration.slice(importFunctionStart, importFunctionEnd);
    assert.match(importFunction, /from public\.app_users[\s\S]*?for\s+update/i);
    assert.match(importFunction, /from public\.app_user_state[\s\S]*?for\s+update/i);
    assert.match(importFunction, /if state_exists then[\s\S]*?else[\s\S]*?insert into public\.app_user_state/i);
});

test('role-scoped progress RPC projects each record exam and falls back only for legacy records', async () => {
    const migration = await readFile(new URL('../supabase/migrations/202610010002_role_scoped_progress.sql', import.meta.url), 'utf8');
    assert.match(migration, /create or replace function public\.commit_app_user_state/i);
    assert.match(migration, /when progress_entry\.value->>'exam' = 'CONSTABLE' then 'CONSTABLE'/i);
    assert.match(migration, /when progress_entry\.value->>'exam' = 'SI' then 'SI'/i);
    assert.match(migration, /when next_data->>'exam' = 'CONSTABLE' then 'CONSTABLE'/i);
    assert.match(migration, /progress_exam,/i);
    assert.equal(/create table|alter table|drop table|drop column|truncate|delete from public\.app_users/i.test(migration), false);
});