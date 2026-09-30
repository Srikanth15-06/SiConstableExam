import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { fetchAuthorizedGoogleDriveApi, getGoogleDriveRootFolderId } from './google-drive-service.mjs';

const ACCOUNT_INDEX_FILE = 'ts-police-ai-accounts.enc.json';
const USER_FILE_PREFIX = 'ts-police-ai-user-';
const MAX_WRITE_RETRIES = 4;
const DATA_FILE_MIME_TYPE = 'application/octet-stream';

function getEncryptionKey() {
    const configured = String(process.env.GOOGLE_DRIVE_APP_DATA_ENCRYPTION_KEY || '').trim();
    const key = /^[a-f\d]{64}$/i.test(configured)
        ? Buffer.from(configured, 'hex')
        : Buffer.from(configured, 'base64');
    if (key.length !== 32) {
        const error = new Error('GOOGLE_DRIVE_APP_DATA_ENCRYPTION_KEY must decode to exactly 32 bytes.');
        error.code = 'MISSING_APP_DATA_ENCRYPTION_KEY';
        throw error;
    }
    return key;
}

function dataError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function clone(value) {
    return structuredClone(value);
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function encryptRecord(record, fileName, key) {
    const iv = randomBytes(12);
    const writeId = randomUUID();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`ts-police-drive-data:${fileName}:v1`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    return {
        schemaVersion: 1,
        encryptionVersion: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        writeId
    };
}

function decryptRecord(envelope, fileName, key) {
    if (!envelope || envelope.schemaVersion !== 1 || envelope.encryptionVersion !== 1
        || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string'
        || typeof envelope.ciphertext !== 'string' || typeof envelope.writeId !== 'string') {
        throw dataError('DRIVE_DATA_CORRUPT', `Stored application record ${fileName} has an unsupported or malformed encryption envelope.`);
    }
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from(`ts-police-drive-data:${fileName}:v1`, 'utf8'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const cleartext = Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final()
        ]).toString('utf8');
        const record = JSON.parse(cleartext);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid record');
        if (record.schemaVersion === undefined || record.schemaVersion === 0) return migrateRecord(record);
        if (record.schemaVersion !== 1) {
            throw dataError('DRIVE_DATA_SCHEMA_UNSUPPORTED', `Stored application record ${fileName} uses a newer schema version.`);
        }
        if (typeof record.userId === 'string' && !Number.isInteger(record.plannerRevision)) {
            record.plannerRevision = 0;
        }
        return record;
    } catch (error) {
        if (error.code === 'DRIVE_DATA_SCHEMA_UNSUPPORTED') throw error;
        throw dataError('DRIVE_DATA_CORRUPT', `Stored application record ${fileName} failed authenticated decryption or validation.`);
    }
}

function migrateRecord(record) {
    if (Array.isArray(record.users)) {
        return { ...record, schemaVersion: 1, revision: Number(record.revision) || 0 };
    }
    if (typeof record.userId === 'string') {
        return {
            ...record,
            schemaVersion: 1,
            revision: Number(record.revision) || 0,
            plannerRevision: Number(record.plannerRevision) || 0,
            userProgress: record.userProgress && typeof record.userProgress === 'object' ? record.userProgress : {},
            testHistory: Array.isArray(record.testHistory) ? record.testHistory : [],
            attempts: Array.isArray(record.attempts) ? record.attempts : []
        };
    }
    throw dataError('DRIVE_DATA_SCHEMA_UNSUPPORTED', 'Stored application record cannot be migrated from its previous schema.');
}

function createDefaultAccountIndex() {
    return { schemaVersion: 1, revision: 0, users: [] };
}

function createDefaultUserData(userId, name, email) {
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}

function escapeDriveQuery(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function createDriveTransport(rootFolderId) {
    async function listFiles(name) {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('q', `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(rootFolderId)}' in parents and trashed = false`);
        url.searchParams.set('pageSize', '10');
        url.searchParams.set('fields', 'files(id,name,mimeType,parents,headRevisionId,modifiedTime)');
        const response = await fetchAuthorizedGoogleDriveApi(url);
        const data = await response.json().catch(() => ({}));
        if (!Array.isArray(data.files)) throw dataError('DRIVE_DATA_STORAGE_FAILED', 'Google Drive returned an invalid application-record listing.');
        return data.files.filter((file) => file.name === name && file.parents?.includes(rootFolderId));
    }

    async function getMetadata(fileId) {
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
        url.searchParams.set('fields', 'id,name,mimeType,parents,headRevisionId,modifiedTime');
        const response = await fetchAuthorizedGoogleDriveApi(url);
        return { ...(await response.json()), etag: response.headers.get('etag') || null };
    }

    async function readContent(fileId) {
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
        url.searchParams.set('alt', 'media');
        const response = await fetchAuthorizedGoogleDriveApi(url);
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            throw dataError('DRIVE_DATA_CORRUPT', 'A stored application record is not valid JSON.');
        }
    }

    async function createFile(name, envelope) {
        const boundary = `police-app-data-${randomUUID()}`;
        const metadata = JSON.stringify({
            name,
            mimeType: DATA_FILE_MIME_TYPE,
            parents: [rootFolderId],
            description: 'Encrypted TS Police AI Prep application record. Managed by the backend.'
        });
        const content = JSON.stringify(envelope);
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\nContent-Type: application/json; charset=UTF-8\n\n${metadata}\n--${boundary}\nContent-Type: application/json\n\n`),
            Buffer.from(content),
            Buffer.from(`\n--${boundary}--`)
        ]);
        const url = new URL('https://www.googleapis.com/upload/drive/v3/files');
        url.searchParams.set('uploadType', 'multipart');
        url.searchParams.set('fields', 'id,name,mimeType,parents,headRevisionId,modifiedTime');
        const response = await fetchAuthorizedGoogleDriveApi(url, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });
        return response.json();
    }

    async function replaceFile(fileId, envelope, etag) {
        const url = new URL(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}`);
        url.searchParams.set('uploadType', 'media');
        return fetchAuthorizedGoogleDriveApi(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
            body: JSON.stringify(envelope)
        });
    }

    async function deleteFile(fileId) {
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
        await fetchAuthorizedGoogleDriveApi(url, { method: 'DELETE' });
    }

    return { listFiles, getMetadata, readContent, createFile, replaceFile, deleteFile };
}

export class DriveDataStore {
    constructor({ rootFolderId = getGoogleDriveRootFolderId(), transport, encryptionKey } = {}) {
        if (!rootFolderId) throw dataError('MISSING_ROOT_FOLDER', 'The existing Notes Library root is not configured.');
        this.rootFolderId = rootFolderId;
        this.key = encryptionKey || getEncryptionKey();
        this.transport = transport || createDriveTransport(rootFolderId);
        this.writeQueue = Promise.resolve();
    }

    runSerialized(operation) {
        const result = this.writeQueue.then(operation, operation);
        this.writeQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    accountFileForUser(userId) {
        if (!/^usr_[a-f\d-]{36}$/i.test(String(userId || ''))) throw dataError('INVALID_USER_ID', 'The account identifier is invalid.');
        return `${USER_FILE_PREFIX}${userId}.enc.json`;
    }

    async findFile(fileName) {
        const files = await this.transport.listFiles(fileName);
        if (files.length > 1) throw dataError('DRIVE_DATA_DUPLICATE_FILE', `Multiple application records named ${fileName} exist in the configured root.`);
        return files[0] || null;
    }

    async loadRecord(fileName, defaultFactory) {
        const file = await this.findFile(fileName);
        if (!file) return { record: defaultFactory(), file: null };
        if (file.mimeType !== DATA_FILE_MIME_TYPE || !file.parents?.includes(this.rootFolderId)) {
            throw dataError('DRIVE_DATA_CORRUPT', `Application record ${fileName} is not stored directly in the configured root.`);
        }
        const envelope = await this.transport.readContent(file.id);
        return { record: decryptRecord(envelope, fileName, this.key), file };
    }

    async saveRecord(fileName, record, expectedFile) {
        const writeId = randomUUID();
        const envelope = encryptRecord(record, fileName, this.key);
        if (!expectedFile) {
            await this.transport.createFile(fileName, envelope);
        } else {
            const latest = await this.transport.getMetadata(expectedFile.id);
            if (latest.headRevisionId !== expectedFile.headRevisionId) {
                throw dataError('DRIVE_DATA_CONFLICT', 'Application data changed during this update. Retry the request.');
            }
            await this.transport.replaceFile(expectedFile.id, envelope);
            await this.transport.replaceFile(expectedFile.id, envelope, latest.etag);
        }

        const afterWrite = await this.findFile(fileName);
        if (!afterWrite || (expectedFile && afterWrite.id !== expectedFile.id)) {
            throw dataError('DRIVE_DATA_CONFLICT', 'Application data changed during this update. Retry the request.');
        }
        const savedEnvelope = await this.transport.readContent(afterWrite.id);
        if (savedEnvelope.writeId !== envelope.writeId) {
            throw dataError('DRIVE_DATA_CONFLICT', 'Application data changed during this update. Retry the request.');
        }
        return { ...afterWrite, writeId };
    }

    async updateRecord(fileName, defaultFactory, update) {
        for (let retry = 0; retry < MAX_WRITE_RETRIES; retry += 1) {
            const { record, file } = await this.loadRecord(fileName, defaultFactory);
            const next = await update(clone(record));
            if (!next || typeof next !== 'object' || Array.isArray(next)) {
                throw dataError('INVALID_DRIVE_RECORD', 'The application produced an invalid storage record.');
            }
            next.schemaVersion = 1;
            next.revision = (Number(record.revision) || 0) + 1;
            next.updatedAt = new Date().toISOString();
            try {
                await this.saveRecord(fileName, next, file);
                return next;
            } catch (error) {
                if (error.code !== 'DRIVE_DATA_CONFLICT' || retry === MAX_WRITE_RETRIES - 1) throw error;
            }
        }
        throw dataError('DRIVE_DATA_CONFLICT', 'Application data changed repeatedly. Retry the request.');
    }

    async createAccount({ name, email, passwordHash }) {
        const normalizedEmail = normalizeEmail(email);
        if (!name || !normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
            throw dataError('INVALID_ACCOUNT', 'Provide a valid name and email address.');
        }
        if (!/^\$2[aby]\$\d\d\$/.test(String(passwordHash || ''))) {
            throw dataError('INVALID_ACCOUNT', 'A bcrypt password hash is required.');
        }
        return this.runSerialized(async () => {
            const userId = `usr_${randomUUID()}`;
            const dataFile = this.accountFileForUser(userId);
            await this.updateRecord(dataFile, () => createDefaultUserData(userId, name.trim(), normalizedEmail), (record) => record);
            try {
                const index = await this.updateRecord(ACCOUNT_INDEX_FILE, createDefaultAccountIndex, (record) => {
                    if (!Array.isArray(record.users)) throw dataError('DRIVE_DATA_CORRUPT', 'The account index is malformed.');
                    if (record.users.some((account) => normalizeEmail(account.email) === normalizedEmail)) {
                        throw dataError('ACCOUNT_EXISTS', 'Unable to create this account. Sign in or use another email address.');
                    }
                    record.users.push({
                        userId,
                        email: normalizedEmail,
                        name: name.trim(),
                        passwordHash,
                        status: 'active',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        lastLoginAt: null
                    });
                    return record;
                });
                const account = index.users.find((entry) => entry.userId === userId);
                if (!account) throw dataError('DRIVE_DATA_CONFLICT', 'Unable to finish account creation. Retry the request.');
                return this.publicAccount(account);
            } catch (error) {
                const orphanedFile = await this.findFile(dataFile).catch(() => null);
                if (orphanedFile) await this.transport.deleteFile(orphanedFile.id).catch(() => { });
                throw error;
            }
        });
    }

    async findAccountByEmail(email) {
        const normalizedEmail = normalizeEmail(email);
        const { record } = await this.loadRecord(ACCOUNT_INDEX_FILE, createDefaultAccountIndex);
        if (!Array.isArray(record.users)) throw dataError('DRIVE_DATA_CORRUPT', 'The account index is malformed.');
        return record.users.find((account) => normalizeEmail(account.email) === normalizedEmail) || null;
    }

    async findAccountById(userId) {
        const { record } = await this.loadRecord(ACCOUNT_INDEX_FILE, createDefaultAccountIndex);
        if (!Array.isArray(record.users)) throw dataError('DRIVE_DATA_CORRUPT', 'The account index is malformed.');
        return record.users.find((account) => account.userId === userId) || null;
    }

    async recordLogin(userId) {
        return this.runSerialized(() => this.updateRecord(ACCOUNT_INDEX_FILE, createDefaultAccountIndex, (record) => {
            const account = record.users?.find((entry) => entry.userId === userId && entry.status === 'active');
            if (!account) throw dataError('ACCOUNT_NOT_FOUND', 'Account is not available.');
            account.lastLoginAt = new Date().toISOString();
            return record;
        }).then((record) => this.publicAccount(record.users.find((account) => account.userId === userId))));
    }

    async updateProfile(userId, { name, exam }) {
        const safeName = String(name || '').normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
        if (!safeName || !['SI', 'CONSTABLE'].includes(exam)) throw dataError('INVALID_ACCOUNT_PROFILE', 'The profile update is invalid.');
        return this.runSerialized(async () => {
            const fileName = this.accountFileForUser(userId);
            await this.updateRecord(fileName, () => {
                throw dataError('USER_DATA_NOT_FOUND', 'Account data is unavailable.');
            }, (record) => {
                if (record.userId !== userId) throw dataError('DRIVE_DATA_CORRUPT', 'Account data does not match its record identifier.');
                record.profile.name = safeName;
                record.exam = exam;
                if (record.plannerData) record.plannerData.examType = exam;
                return record;
            });
            const index = await this.updateRecord(ACCOUNT_INDEX_FILE, createDefaultAccountIndex, (record) => {
                const account = record.users?.find((entry) => entry.userId === userId && entry.status === 'active');
                if (!account) throw dataError('ACCOUNT_NOT_FOUND', 'Account is not available.');
                account.name = safeName;
                return record;
            });
            return this.publicAccount(index.users.find((account) => account.userId === userId));
        });
    }

    publicAccount(account) {
        if (!account) return null;
        const { userId, email, name, status, createdAt, updatedAt, lastLoginAt } = account;
        return { userId, email, name, status, createdAt, updatedAt, lastLoginAt };
    }

    async getUserData(userId) {
        const fileName = this.accountFileForUser(userId);
        const { record } = await this.loadRecord(fileName, () => {
            throw dataError('USER_DATA_NOT_FOUND', 'Account data is unavailable.');
        });
        if (record.userId !== userId) throw dataError('DRIVE_DATA_CORRUPT', 'Account data does not match its record identifier.');
        return record;
    }

    async updateUserData(userId, update) {
        const fileName = this.accountFileForUser(userId);
        return this.runSerialized(() => this.updateRecord(fileName, () => {
            throw dataError('USER_DATA_NOT_FOUND', 'Account data is unavailable.');
        }, async (record) => {
            if (record.userId !== userId) throw dataError('DRIVE_DATA_CORRUPT', 'Account data does not match its record identifier.');
            return update(record);
        }));
    }

    async exportUserRecordsForMigration() {
        const { record: index } = await this.loadRecord(ACCOUNT_INDEX_FILE, createDefaultAccountIndex);
        if (!Array.isArray(index.users)) throw dataError('DRIVE_DATA_CORRUPT', 'The account index is malformed.');
        const exported = [];
        for (const account of index.users) {
            const userData = await this.getUserData(account.userId);
            exported.push({ account: clone(account), userData });
        }
        return exported;
    }

    async deleteRecord(fileName) {
        if (fileName === ACCOUNT_INDEX_FILE || !/^ts-police-ai-user-usr_[a-f\d-]{36}\.enc\.json$/i.test(fileName)) {
            throw dataError('INVALID_DRIVE_RECORD', 'Refusing to delete an unrecognized application record.');
        }
        return this.runSerialized(async () => {
            const file = await this.findFile(fileName);
            if (file) await this.transport.deleteFile(file.id);
            return Boolean(file);
        });
    }
}

let defaultStore;

export function getDriveDataStore() {
    if (!defaultStore) defaultStore = new DriveDataStore();
    return defaultStore;
}

export function isDriveDataEncryptionKeyConfigured() {
    try {
        getEncryptionKey();
        return true;
    } catch {
        return false;
    }
}

export const DRIVE_DATA_FILES = Object.freeze({ accountIndex: ACCOUNT_INDEX_FILE, userPrefix: USER_FILE_PREFIX });
