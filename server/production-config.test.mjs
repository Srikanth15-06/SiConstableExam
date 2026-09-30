import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionEnvironment, REQUIRED_DRIVE_ROOT_FOLDER_ID } from './production-config.mjs';

const validEnvironment = {
    NODE_ENV: 'production',
    RENDER: 'true',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'configured-server-only-key',
    SESSION_SECRET: 'a'.repeat(64),
    FRONTEND_URL: 'https://frontend.example.test',
    GOOGLE_DRIVE_ROOT_FOLDER_ID: REQUIRED_DRIVE_ROOT_FOLDER_ID
};

test('production validation requires Supabase and secure server configuration but not Google credentials', () => {
    assert.deepEqual(validateProductionEnvironment(validEnvironment), []);
});

test('production validation names missing Supabase/session variables without exposing values', () => {
    const issues = validateProductionEnvironment({ NODE_ENV: 'production', RENDER: 'true' });
    assert.ok(issues.some((issue) => issue.includes('SUPABASE_URL')));
    assert.ok(issues.some((issue) => issue.includes('SUPABASE_SERVICE_ROLE_KEY')));
    assert.ok(issues.some((issue) => issue.includes('SESSION_SECRET')));
    assert.ok(issues.some((issue) => issue.includes('FRONTEND_URL')));
    assert.equal(issues.some((issue) => issue.includes('GOOGLE_CLIENT_SECRET')), false);
    assert.equal(issues.some((issue) => issue.includes('GOOGLE_DRIVE_TOKEN_VAULT_SERVICE_ACCOUNT_JSON')), false);
});

test('production validation rejects insecure URLs and a changed Drive root', () => {
    const issues = validateProductionEnvironment({
        ...validEnvironment,
        SUPABASE_URL: 'http://project.supabase.co',
        FRONTEND_URL: 'http://frontend.example.test',
        GOOGLE_DRIVE_ROOT_FOLDER_ID: 'another-root'
    });
    assert.ok(issues.some((issue) => issue.includes('must use HTTPS')));
    assert.ok(issues.some((issue) => issue.includes('existing Notes Library root')));
});

test('production Google OAuth validation checks the deployed HTTPS callback when configured', () => {
    const issues = validateProductionEnvironment({
        ...validEnvironment,
        GOOGLE_CLIENT_ID: 'configured',
        GOOGLE_CLIENT_SECRET: 'configured',
        GOOGLE_REDIRECT_URI: 'http://localhost:8787/api/drive/oauth2callback'
    });
    assert.ok(issues.some((issue) => issue.includes('GOOGLE_REDIRECT_URI')));
});

test('Render rejects a non-production NODE_ENV', () => {
    assert.deepEqual(validateProductionEnvironment({ NODE_ENV: 'development', RENDER: 'true' }), [
        'NODE_ENV must be production on Render'
    ]);
});