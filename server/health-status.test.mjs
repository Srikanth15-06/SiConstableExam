import test from 'node:test';
import assert from 'node:assert/strict';
import { getHealthStatus } from './health-status.mjs';

test('health reports unconfigured database without exposing configuration values', async () => {
    const status = await getHealthStatus({ databaseConfigured: false, checkDatabase: async () => assert.fail('must not connect') });
    assert.equal(status.statusCode, 503);
    assert.deepEqual(status.body, {
        ok: false,
        ready: false,
        service: 'TS Police AI Prep API',
        database: { provider: 'supabase', configured: false, reachable: false }
    });
    assert.equal(JSON.stringify(status).includes('SERVICE_ROLE'), false);
});

test('health reports ready only after a successful database reachability check', async () => {
    const status = await getHealthStatus({ databaseConfigured: true, checkDatabase: async () => true });
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.ready, true);
    assert.deepEqual(status.body.database, { provider: 'supabase', configured: true, reachable: true });
});

test('health reports database unreachable without leaking an error', async () => {
    const status = await getHealthStatus({ databaseConfigured: true, checkDatabase: async () => { throw new Error('private connection string'); } });
    assert.equal(status.statusCode, 503);
    assert.equal(status.body.database.reachable, false);
    assert.equal(JSON.stringify(status).includes('private connection string'), false);
});