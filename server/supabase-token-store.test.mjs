import test from 'node:test';
import assert from 'node:assert/strict';
import { getSupabaseClient } from './supabase-client.mjs';
import { getGoogleDriveTokenStorageStatus, getStoredGoogleDriveToken, storeGoogleDriveToken, clearStoredGoogleDriveToken } from './drive-token-store.mjs';

test('Google OAuth tokens use encrypted Supabase storage without a service-account credential', async (context) => {
    const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY', 'GOOGLE_DRIVE_TOKEN_VAULT_SERVICE_ACCOUNT_JSON', 'GOOGLE_DRIVE_TOKEN_FILE', 'NODE_ENV'];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const originalFetch = globalThis.fetch;
    let encryptedPayload = null;

    process.env.SUPABASE_URL = 'https://supabase.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiZXhwIjo5OTk5OTk5OTk5fQ.test-signature';
    process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
    delete process.env.GOOGLE_DRIVE_TOKEN_VAULT_SERVICE_ACCOUNT_JSON;
    process.env.GOOGLE_DRIVE_TOKEN_FILE = '.data/should-not-be-used.enc';
    process.env.NODE_ENV = 'production';

    globalThis.fetch = async (input, options = {}) => {
        const request = input instanceof Request ? input : new Request(input, options);
        const url = new URL(request.url);
        assert.match(url.pathname, /\/rest\/v1\/drive_oauth_tokens$/);
        if (request.method === 'POST') {
            const body = await request.clone().json();
            encryptedPayload = body.encrypted_payload;
            return new Response(null, { status: 204 });
        }
        if (request.method === 'DELETE') {
            encryptedPayload = null;
            return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify(encryptedPayload ? [{ encrypted_payload: encryptedPayload }] : []), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' }
        });
    };

    context.after(() => {
        globalThis.fetch = originalFetch;
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    });

    const status = getGoogleDriveTokenStorageStatus();
    assert.deepEqual(status, {
        configured: true,
        durable: true,
        provider: 'supabase-encrypted',
        encryptionKeyConfigured: true
    });
    assert.doesNotThrow(() => getSupabaseClient());

    const token = { access_token: 'test-access-token', refresh_token: 'test-refresh-token', expiry_date: 123456789 };
    await storeGoogleDriveToken(token);
    assert.ok(encryptedPayload);
    assert.equal(JSON.stringify(encryptedPayload).includes(token.access_token), false);
    assert.equal(JSON.stringify(encryptedPayload).includes(token.refresh_token), false);
    assert.deepEqual(await getStoredGoogleDriveToken(), token);
    await clearStoredGoogleDriveToken();
    assert.equal(await getStoredGoogleDriveToken(), null);
});