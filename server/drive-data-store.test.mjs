import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveDataStore } from './drive-data-store.mjs';

const ROOT_ID = 'existing-root-id';
const MIME_TYPE = 'application/octet-stream';

function createMemoryTransport() {
    const files = new Map();
    let nextId = 1;
    let driftRevisionOnce = false;

    return {
        files,
        setDriftRevisionOnce() {
            driftRevisionOnce = true;
        },
        async listFiles(name) {
            return [...files.values()]
                .filter((file) => file.name === name && file.parents.includes(ROOT_ID))
                .map(({ id, name: fileName, mimeType, parents, headRevisionId, modifiedTime }) => ({
                    id, name: fileName, mimeType, parents, headRevisionId, modifiedTime
                }));
        },
        async getMetadata(fileId) {
            const file = files.get(fileId);
            assert.ok(file);
            const revision = driftRevisionOnce ? `external-${file.headRevisionId}` : file.headRevisionId;
            driftRevisionOnce = false;
            return {
                id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                parents: file.parents,
                headRevisionId: revision,
                modifiedTime: file.modifiedTime
            };
        },
        async readContent(fileId) {
            const file = files.get(fileId);
            assert.ok(file);
            return structuredClone(file.envelope);
        },
        async createFile(name, envelope) {
            const id = `drive-file-${nextId++}`;
            files.set(id, {
                id,
                name,
                mimeType: MIME_TYPE,
                parents: [ROOT_ID],
                headRevisionId: '1',
                modifiedTime: new Date().toISOString(),
                envelope: structuredClone(envelope)
            });
            return { id };
        },
        async replaceFile(fileId, envelope) {
            const file = files.get(fileId);
            assert.ok(file);
            file.envelope = structuredClone(envelope);
            file.headRevisionId = String(Number(file.headRevisionId) + 1);
            file.modifiedTime = new Date().toISOString();
        },
        async deleteFile(fileId) {
            files.delete(fileId);
        }
    };
}

function createStore(transport = createMemoryTransport()) {
    return { store: new DriveDataStore({ rootFolderId: ROOT_ID, transport, encryptionKey: Buffer.alloc(32, 9) }), transport };
}

const accountInput = (name, email) => ({
    name,
    email,
    passwordHash: '$2b$10$not-a-real-hash-used-only-by-this-storage-test'
});

test('Drive data records are encrypted and isolated by server-generated user IDs', async () => {
    const { store, transport } = createStore();
    const accountA = await store.createAccount(accountInput('Candidate A', 'candidate-a@example.test'));
    const accountB = await store.createAccount(accountInput('Candidate B', 'candidate-b@example.test'));

    assert.match(accountA.userId, /^usr_[a-f\d-]{36}$/i);
    assert.notEqual(accountA.userId, accountB.userId);
    assert.equal('passwordHash' in accountA, false);

    await store.updateUserData(accountA.userId, (record) => {
        record.userProgress = { Percentages: { attempts: 15, accuracy: 50 } };
        record.testHistory = [{ attemptId: 'attempt-a-1', accuracy: 50 }];
        return record;
    });

    const dataA = await store.getUserData(accountA.userId);
    const dataB = await store.getUserData(accountB.userId);
    assert.equal(dataA.userProgress.Percentages.attempts, 15);
    assert.equal(dataB.userProgress.Percentages, undefined);
    assert.deepEqual(dataB.testHistory, []);

    const accountFile = [...transport.files.values()].find((file) => file.name === 'ts-police-ai-accounts.enc.json');
    assert.equal(accountFile.parents[0], ROOT_ID);
    assert.equal(accountFile.mimeType, MIME_TYPE);
    const serializedEnvelope = JSON.stringify(accountFile.envelope);
    assert.equal(serializedEnvelope.includes('candidate-a@example.test'), false);
    assert.equal(serializedEnvelope.includes(accountA.userId), false);
    assert.equal('ciphertext' in accountFile.envelope, true);
});

test('duplicate account creation is rejected without leaving an orphan user record', async () => {
    const { store, transport } = createStore();
    await store.createAccount(accountInput('Candidate A', 'duplicate@example.test'));

    await assert.rejects(
        store.createAccount(accountInput('Second Candidate', 'DUPLICATE@example.test')),
        (error) => error.code === 'ACCOUNT_EXISTS'
    );
    assert.equal([...transport.files.values()].filter((file) => file.name.startsWith('ts-police-ai-user-')).length, 1);
});

test('Drive data updates retry after a storage revision conflict', async () => {
    const transport = createMemoryTransport();
    const store = new DriveDataStore({ rootFolderId: ROOT_ID, transport, encryptionKey: Buffer.alloc(32, 3) });
    const account = await store.createAccount(accountInput('Candidate A', 'race@example.test'));
    transport.setDriftRevisionOnce();

    await store.updateUserData(account.userId, (record) => {
        record.exam = 'CONSTABLE';
        return record;
    });

    assert.equal((await store.getUserData(account.userId)).exam, 'CONSTABLE');
});

test('user accounts and progress remain readable through a fresh store instance', async () => {
    const transport = createMemoryTransport();
    const key = Buffer.alloc(32, 6);
    const firstStore = new DriveDataStore({ rootFolderId: ROOT_ID, transport, encryptionKey: key });
    const account = await firstStore.createAccount(accountInput('Restart Candidate', 'restart@example.test'));
    await firstStore.updateUserData(account.userId, (record) => {
        record.userProgress = { Percentages: { attempts: 15, accuracy: 50 } };
        record.testHistory = [{ attemptId: 'attempt-before-restart', accuracy: 50 }];
        return record;
    });

    const restartedStore = new DriveDataStore({ rootFolderId: ROOT_ID, transport, encryptionKey: key });
    const restoredAccount = await restartedStore.findAccountByEmail('restart@example.test');
    const restoredData = await restartedStore.getUserData(account.userId);
    assert.equal(restoredAccount.userId, account.userId);
    assert.equal(restoredData.userProgress.Percentages.attempts, 15);
    assert.equal(restoredData.testHistory[0].accuracy, 50);
});

test('tampered ciphertext is rejected instead of appearing as empty user data', async () => {
    const { store, transport } = createStore();
    const account = await store.createAccount(accountInput('Candidate A', 'tamper@example.test'));
    const userFile = [...transport.files.values()].find((file) => file.name.includes(account.userId));
    const ciphertext = userFile.envelope.ciphertext;
    userFile.envelope.ciphertext = `${ciphertext.slice(0, -2)}AA`;

    await assert.rejects(
        store.getUserData(account.userId),
        (error) => error.code === 'DRIVE_DATA_CORRUPT'
    );
});

test('encrypted records are bound to their Drive filename and account identifier', async () => {
    const { store, transport } = createStore();
    const account = await store.createAccount(accountInput('Candidate A', 'binding@example.test'));
    const userFile = [...transport.files.values()].find((file) => file.name.includes(account.userId));
    userFile.name = 'ts-police-ai-user-usr_00000000-0000-0000-0000-000000000000.enc.json';

    await assert.rejects(
        store.getUserData(account.userId),
        (error) => error.code === 'DRIVE_DATA_CORRUPT' || error.code === 'USER_DATA_NOT_FOUND'
    );
});
