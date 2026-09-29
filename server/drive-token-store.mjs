import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

const TOKEN_PROVIDER = 'google-drive';
let pool;
let tableReady;

function getEncryptionKey() {
    const encodedKey = (process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY || '').trim();
    const key = /^[a-f\d]{64}$/i.test(encodedKey)
        ? Buffer.from(encodedKey, 'hex')
        : Buffer.from(encodedKey, 'base64');
    if (key.length !== 32) {
        const error = new Error('Set GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY to a 32-byte base64 or 64-character hex key.');
        error.code = 'MISSING_DRIVE_TOKEN_ENCRYPTION_KEY';
        throw error;
    }
    return key;
}

function getTokenFilePath() {
    return path.resolve(process.cwd(), process.env.GOOGLE_DRIVE_TOKEN_FILE || '.data/google-drive-token.enc');
}

export function getGoogleDriveTokenStorageStatus() {
    let encryptionKeyConfigured = true;
    try {
        getEncryptionKey();
    } catch {
        encryptionKeyConfigured = false;
    }
    if (process.env.DATABASE_URL?.trim()) {
        return { configured: encryptionKeyConfigured, durable: true, provider: 'postgres', encryptionKeyConfigured };
    }
    const tokenFilePath = process.env.GOOGLE_DRIVE_TOKEN_FILE?.trim();
    const mountedFile = tokenFilePath?.replace(/\\/g, '/').startsWith('/var/data/');
    const explicitlyDurable = process.env.GOOGLE_DRIVE_TOKEN_FILE_DURABLE === 'true';
    const localDevelopment = process.env.NODE_ENV !== 'production';
    return {
        configured: encryptionKeyConfigured && (localDevelopment || Boolean(tokenFilePath && (mountedFile || explicitlyDurable))),
        durable: localDevelopment || Boolean(tokenFilePath && (mountedFile || explicitlyDurable)),
        provider: 'encrypted-file',
        encryptionKeyConfigured
    };
}

function encryptToken(token) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final()]);
    return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64')
    };
}

function decryptToken(envelope) {
    const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
}

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ...(process.env.DATABASE_SSL === 'true'
                ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } }
                : {})
        });
    }
    return pool;
}

async function ensureDatabaseTable() {
    if (!tableReady) {
        tableReady = getPool().query(`
            CREATE TABLE IF NOT EXISTS google_drive_oauth_tokens (
                provider TEXT PRIMARY KEY,
                token_ciphertext JSONB NOT NULL,
                expires_at BIGINT,
                scope TEXT,
                token_type TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `).catch((error) => {
            tableReady = null;
            throw error;
        });
    }
    await tableReady;
}

export async function getStoredGoogleDriveToken() {
    if (process.env.GOOGLE_DRIVE_TOKEN && process.env.NODE_ENV !== 'production') {
        try {
            return JSON.parse(process.env.GOOGLE_DRIVE_TOKEN);
        } catch {
            const error = new Error('The configured Google Drive token is not valid JSON.');
            error.code = 'DRIVE_TOKEN_STORAGE_FAILED';
            throw error;
        }
    }

    try {
        if (process.env.DATABASE_URL?.trim()) {
            await ensureDatabaseTable();
            const result = await getPool().query(
                'SELECT token_ciphertext FROM google_drive_oauth_tokens WHERE provider = $1',
                [TOKEN_PROVIDER]
            );
            return result.rows[0] ? decryptToken(result.rows[0].token_ciphertext) : null;
        }

        const envelope = JSON.parse(await readFile(getTokenFilePath(), 'utf8'));
        return decryptToken(envelope);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'MISSING_DRIVE_TOKEN_ENCRYPTION_KEY' || error.code === 'DRIVE_TOKEN_STORAGE_FAILED') throw error;
        const storageError = new Error('The saved Google Drive authorization could not be read. Check database access or the token encryption key, then reconnect if needed.');
        storageError.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        throw storageError;
    }
}

export async function storeGoogleDriveToken(token) {
    const envelope = encryptToken(token);
    try {
        if (process.env.DATABASE_URL?.trim()) {
            await ensureDatabaseTable();
            await getPool().query(`
                INSERT INTO google_drive_oauth_tokens (provider, token_ciphertext, expires_at, scope, token_type, updated_at)
                VALUES ($1, $2::jsonb, $3, $4, $5, NOW())
                ON CONFLICT (provider) DO UPDATE SET
                    token_ciphertext = EXCLUDED.token_ciphertext,
                    expires_at = EXCLUDED.expires_at,
                    scope = EXCLUDED.scope,
                    token_type = EXCLUDED.token_type,
                    updated_at = NOW()
            `, [TOKEN_PROVIDER, JSON.stringify(envelope), token.expiry || null, token.scope || null, token.token_type || null]);
            return;
        }

        const tokenFilePath = getTokenFilePath();
        await mkdir(path.dirname(tokenFilePath), { recursive: true });
        const temporaryPath = `${tokenFilePath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(envelope), { mode: 0o600 });
        await rename(temporaryPath, tokenFilePath);
    } catch (error) {
        if (error.code === 'MISSING_DRIVE_TOKEN_ENCRYPTION_KEY') throw error;
        const storageError = new Error('The Google Drive authorization could not be saved. Check database access or persistent token-file storage.');
        storageError.code = 'DRIVE_TOKEN_STORAGE_FAILED';
        throw storageError;
    }
}

export async function clearStoredGoogleDriveToken() {
    if (process.env.DATABASE_URL?.trim()) {
        await ensureDatabaseTable();
        await getPool().query('DELETE FROM google_drive_oauth_tokens WHERE provider = $1', [TOKEN_PROVIDER]);
        return;
    }
    try {
        await unlink(getTokenFilePath());
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}