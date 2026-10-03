import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { createAuthenticationRouter, InMemorySessionStore } from './auth-service.mjs';
import { createUserDataRouter } from './user-data-routes.mjs';
import { getProgressKey } from '../frontend/src/planner-utils.js';

function publicAccount(account) {
    const { passwordHash: _passwordHash, ...safe } = account;
    return safe;
}

function createMemoryStore() {
    const accounts = new Map();
    const records = new Map();
    let queue = Promise.resolve();
    const serialize = (action) => {
        const result = queue.then(action, action);
        queue = result.then(() => undefined, () => undefined);
        return result;
    };
    return {
        async createAccount({ name, email, passwordHash }) {
            if (accounts.has(email)) throw Object.assign(new Error('duplicate'), { code: 'ACCOUNT_EXISTS' });
            const userId = `usr_${randomUUID()}`;
            const account = { userId, name, email, passwordHash, status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null };
            accounts.set(email, account);
            records.set(userId, {
                schemaVersion: 1, revision: 0, userId, profile: { name, email }, exam: 'SI',
                userProgress: {}, testHistory: [], attempts: [], seenQuestionCount: 0, testAttemptCounter: 0,
                plannerData: { examType: 'SI', generatedAt: null, summary: {}, topicMetrics: [], schedule: [] }
            });
            return publicAccount(account);
        },
        async findAccountByEmail(email) { return accounts.get(email) || null; },
        async findAccountById(userId) { return [...accounts.values()].find((account) => account.userId === userId) || null; },
        async recordLogin(userId) {
            const account = [...accounts.values()].find((item) => item.userId === userId);
            account.lastLoginAt = new Date().toISOString();
            return publicAccount(account);
        },
        async updateProfile(userId, { name, exam }) {
            const account = [...accounts.values()].find((item) => item.userId === userId);
            account.name = name;
            const record = records.get(userId);
            record.exam = exam;
            record.profile.name = name;
            record.plannerData.examType = exam;
            return publicAccount(account);
        },
        async getUserData(userId) {
            const record = records.get(userId);
            if (!record) throw Object.assign(new Error('missing'), { code: 'USER_DATA_NOT_FOUND' });
            return structuredClone(record);
        },
        async updateUserData(userId, updater) {
            return serialize(async () => {
                const current = records.get(userId);
                if (!current) throw Object.assign(new Error('missing'), { code: 'USER_DATA_NOT_FOUND' });
                const next = await updater(structuredClone(current));
                next.revision += 1;
                records.set(userId, structuredClone(next));
                return structuredClone(next);
            });
        },
        records
    };
}

function makeQuestions() {
    return Array.from({ length: 10 }, (_, index) => ({
        id: `q-${index + 1}`,
        question: `Question ${index + 1}`,
        options: [`Correct ${index + 1}`, `Wrong A ${index + 1}`, `Wrong B ${index + 1}`, `Wrong C ${index + 1}`],
        correctAnswer: `Correct ${index + 1}`,
        explanation: `Explanation ${index + 1}`,
        shortcut: `Shortcut ${index + 1}`,
        subject: 'Arithmetic',
        topic: 'Percentages',
        difficulty: 'Beginner'
    }));
}

async function createServer({ generateQuestionSet } = {}) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    const dataStore = createMemoryStore();
    const sessions = new InMemorySessionStore({ ttlMs: 60_000 });
    const allowedOrigins = new Set(['https://frontend.example.test']);
    const generated = [];
    app.use('/api', createAuthenticationRouter({ dataStore, sessions, allowedOrigins }));
    app.use('/api', createUserDataRouter({
        dataStore,
        sessions,
        allowedOrigins,
        generateQuestionSet: generateQuestionSet || (async (input) => {
            generated.push(input);
            return makeQuestions();
        })
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, generated, dataStore };
}

function authHeaders(cookie, origin = 'https://frontend.example.test') {
    return { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
}

async function signUp(baseUrl, name, email) {
    await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { Origin: 'https://frontend.example.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password: 'integration-test-password' })
    });
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: 'https://frontend.example.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'integration-test-password' })
    });
    assert.equal(response.status, 200);
    return { user: (await response.json()).user, cookie: response.headers.get('set-cookie').split(';')[0] };
}

async function startAttempt(baseUrl, cookie, idempotencyKey, exam = 'SI') {
    return fetch(`${baseUrl}/api/tests`, {
        method: 'POST',
        headers: { ...authHeaders(cookie), 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ exam, subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner' })
    });
}

async function switchExam(baseUrl, cookie, exam) {
    return fetch(`${baseUrl}/api/me/profile`, {
        method: 'PATCH',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'Candidate', exam })
    });
}

async function completeAttempt(baseUrl, cookie, exam, correctCount) {
    const created = await startAttempt(baseUrl, cookie, randomUUID(), exam);
    const { attempt } = await created.json();
    assert.equal(created.status, 201);
    const answers = Array.from({ length: 10 }, (_, index) => ({
        questionId: `q-${index + 1}`,
        selectedAnswer: index < correctCount ? `Correct ${index + 1}` : `Wrong A ${index + 1}`
    }));
    const submitted = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/submit`, {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ answers })
    });
    assert.equal(submitted.status, 200);
    return (await submitted.json()).result;
}

test('test creation creates exactly one active attempt when none exists', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Candidate', 'no-active@example.test');

    const response = await startAttempt(baseUrl, user.cookie, randomUUID());
    const { attempt } = await response.json();
    const attempts = dataStore.records.get(user.user.userId).attempts;

    assert.equal(response.status, 201);
    assert.equal(attempt.status, 'in_progress');
    assert.equal(attempts.filter((item) => item.status === 'in_progress').length, 1);
});

test('revision mocks use practiced topics, configurable lengths, and update each topic progress safely', async (context) => {
    const { server, baseUrl, dataStore, generated } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Candidate', 'revision-mock@example.test');
    const headers = authHeaders(user.cookie);
    const createMock = (questionCount, durationMinutes, idempotencyKey = randomUUID()) => fetch(`${baseUrl}/api/tests/mock`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ exam: 'SI', questionCount, durationMinutes })
    });

    const invalid = await createMock(50, 60);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_MOCK_CONFIGURATION');
    const noTopics = await createMock(60, 60);
    assert.equal(noTopics.status, 400);
    assert.equal((await noTopics.json()).code, 'NO_PRACTICED_TOPICS');
    assert.equal(generated.length, 0);

    const record = dataStore.records.get(user.user.userId);
    for (const [topic, accuracy] of [['Percentages', 60], ['Profit and Loss', 70]]) {
        record.userProgress[getProgressKey('SI', 'Arithmetic', topic)] = {
            exam: 'SI', subject: 'Arithmetic', topic, level: 'Beginner',
            attempts: 1, bestScore: 6, correctAnswers: 6, totalQuestions: 10, accuracy
        };
    }

    const created = await createMock(60, 60);
    const { attempt } = await created.json();
    assert.equal(created.status, 201);
    assert.equal(attempt.mode, 'revision-mock');
    assert.equal(attempt.durationSeconds, 3600);
    assert.equal(attempt.questions.length, 60);
    assert.equal(new Set(attempt.questions.map((question) => question.id)).size, 60);
    assert.deepEqual(new Set(attempt.questions.map((question) => question.topic)), new Set(['Percentages', 'Profit and Loss']));
    assert.equal(generated.length, 6);
    assert.ok(generated.every((input) => input.count === 10));
    assert.equal(JSON.stringify(attempt).includes('correctAnswer'), false);

    const answerList = Array.from({ length: 60 }, (_, index) => ({
        questionId: attempt.questions[index].id,
        selectedAnswer: attempt.questions[index].options[0]
    }));
    const answerResponse = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/answers`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ answers: Object.fromEntries(answerList.map((answer) => [answer.questionId, answer.selectedAnswer])) })
    });
    assert.equal(answerResponse.status, 200);

    dataStore.records.get(user.user.userId).attempts.find((item) => item.attemptId === attempt.attemptId).startedAt = new Date(Date.now() - 3661_000).toISOString();
    const expiredSave = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/answers`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ answers: { [attempt.questions[0].id]: attempt.questions[0].options[0] } })
    });
    assert.equal(expiredSave.status, 409);
    assert.equal((await expiredSave.json()).code, 'TEST_TIME_EXPIRED');
    const submitted = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ answers: [] })
    });
    assert.equal(submitted.status, 200);
    const result = (await submitted.json()).result;
    assert.equal(result.mode, 'revision-mock');
    assert.equal(result.total, 60);
    assert.equal(result.correct, 60);
    assert.equal(result.timeTaken, '60:00');
    assert.equal(result.topicBreakdown.length, 2);
    const submittedRecord = dataStore.records.get(user.user.userId);
    for (const topic of ['Percentages', 'Profit and Loss']) {
        const progress = submittedRecord.userProgress[getProgressKey('SI', 'Arithmetic', topic)];
        assert.equal(progress.attempts, 2);
        assert.equal(progress.totalQuestions, 40);
        assert.equal(progress.correctAnswers, 36);
        assert.equal(progress.accuracy, 90);
    }
});

test('repeated test creation with the same idempotency key reuses one attempt', async (context) => {
    let generatorCalls = 0;
    let releaseGenerators;
    const bothGenerating = new Promise((resolve) => { releaseGenerators = resolve; });
    const { server, baseUrl, dataStore } = await createServer({
        generateQuestionSet: async () => {
            generatorCalls += 1;
            if (generatorCalls === 2) releaseGenerators();
            await bothGenerating;
            return makeQuestions();
        }
    });
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Candidate', 'same-key@example.test');
    const idempotencyKey = randomUUID();

    const responses = await Promise.all([
        startAttempt(baseUrl, user.cookie, idempotencyKey),
        startAttempt(baseUrl, user.cookie, idempotencyKey)
    ]);
    const results = await Promise.all(responses.map(async (response) => ({ status: response.status, attempt: (await response.json()).attempt })));
    const replay = await startAttempt(baseUrl, user.cookie, idempotencyKey);
    const replayedAttempt = (await replay.json()).attempt;
    const attempts = dataStore.records.get(user.user.userId).attempts;

    assert.equal(generatorCalls, 2);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
    assert.equal(results[0].attempt.attemptId, results[1].attempt.attemptId);
    assert.equal(replay.status, 200);
    assert.equal(replayedAttempt.attemptId, results[0].attempt.attemptId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts.filter((item) => item.status === 'in_progress').length, 1);
});

test('concurrent different-key requests reuse the one active attempt', async (context) => {
    let generatorCalls = 0;
    let releaseGenerators;
    const bothGenerating = new Promise((resolve) => { releaseGenerators = resolve; });
    const { server, baseUrl, dataStore } = await createServer({
        generateQuestionSet: async () => {
            generatorCalls += 1;
            if (generatorCalls === 2) releaseGenerators();
            await bothGenerating;
            return makeQuestions();
        }
    });
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Candidate', 'different-keys@example.test');

    const responses = await Promise.all([
        startAttempt(baseUrl, user.cookie, randomUUID()),
        startAttempt(baseUrl, user.cookie, randomUUID())
    ]);
    const results = await Promise.all(responses.map(async (response) => ({ status: response.status, attempt: (await response.json()).attempt })));
    const attempts = dataStore.records.get(user.user.userId).attempts;

    assert.equal(generatorCalls, 2);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
    assert.equal(results[0].attempt.attemptId, results[1].attempt.attemptId);
    assert.equal(attempts.filter((item) => item.status === 'in_progress').length, 1);
});

test('data endpoint deterministically returns the newest active attempt', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Candidate', 'multiple-active@example.test');
    const record = dataStore.records.get(user.user.userId);
    record.attempts = [
        { attemptId: 'attempt-older', exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner', startedAt: '2026-09-29T10:00:00.000Z', status: 'in_progress', questions: [] },
        { attemptId: 'attempt-newer', exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner', startedAt: '2026-09-30T10:00:00.000Z', status: 'in_progress', questions: [] }
    ];

    const first = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: user.cookie } })).json();
    const second = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: user.cookie } })).json();

    assert.equal(first.data.activeAttempt.attemptId, 'attempt-newer');
    assert.equal(second.data.activeAttempt.attemptId, 'attempt-newer');
});

test('active attempts are isolated between users', async (context) => {
    const { server, baseUrl } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const userA = await signUp(baseUrl, 'Candidate A', 'active-a@example.test');
    const userB = await signUp(baseUrl, 'Candidate B', 'active-b@example.test');
    const [responseA, responseB] = await Promise.all([
        startAttempt(baseUrl, userA.cookie, randomUUID()),
        startAttempt(baseUrl, userB.cookie, randomUUID())
    ]);
    const attemptA = (await responseA.json()).attempt;
    const attemptB = (await responseB.json()).attempt;
    const [dataA, dataB] = await Promise.all([
        fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userA.cookie } }).then((response) => response.json()),
        fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userB.cookie } }).then((response) => response.json())
    ]);

    assert.equal(dataA.data.activeAttempt.attemptId, attemptA.attemptId);
    assert.equal(dataB.data.activeAttempt.attemptId, attemptB.attemptId);
    assert.notEqual(dataA.data.activeAttempt.attemptId, dataB.data.activeAttempt.attemptId);
});

test('active attempts restore correctly after logout and login as another user', async (context) => {
    const { server, baseUrl } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const userA = await signUp(baseUrl, 'Candidate A', 'restore-a@example.test');
    const attemptAResponse = await startAttempt(baseUrl, userA.cookie, randomUUID());
    const attemptA = (await attemptAResponse.json()).attempt;
    const logoutA = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST', headers: { Origin: 'https://frontend.example.test', Cookie: userA.cookie }
    });
    assert.equal(logoutA.status, 200);

    const userB = await signUp(baseUrl, 'Candidate B', 'restore-b@example.test');
    const attemptBResponse = await startAttempt(baseUrl, userB.cookie, randomUUID());
    const attemptB = (await attemptBResponse.json()).attempt;
    const snapshotB = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userB.cookie } })).json();
    assert.equal(snapshotB.data.activeAttempt.attemptId, attemptB.attemptId);

    const loginA = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: 'https://frontend.example.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'restore-a@example.test', password: 'integration-test-password' })
    });
    assert.equal(loginA.status, 200);
    const cookieA = loginA.headers.get('set-cookie').split(';')[0];
    const snapshotA = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: cookieA } })).json();

    assert.equal(snapshotA.data.activeAttempt.attemptId, attemptA.attemptId);
    assert.notEqual(snapshotA.data.activeAttempt.attemptId, attemptB.attemptId);
});

test('test creation redacts answer keys, server scores once, and users cannot read each other attempts', async (context) => {
    const { server, baseUrl, generated } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const userA = await signUp(baseUrl, 'Candidate A', 'a@example.test');
    const userB = await signUp(baseUrl, 'Candidate B', 'b@example.test');
    const attemptResponse = await fetch(`${baseUrl}/api/tests`, {
        method: 'POST',
        headers: { ...authHeaders(userA.cookie), 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner', count: 2 })
    });
    assert.equal(attemptResponse.status, 201);
    const { attempt } = await attemptResponse.json();
    assert.equal(attempt.questions.length, 10);
    assert.equal(generated[0].count, 10);
    const preSubmitJson = JSON.stringify(attempt);
    for (const secretField of ['correctAnswer', 'answerKey', 'solutionKey', 'explanation', 'shortcut']) {
        assert.equal(preSubmitJson.includes(secretField), false, `${secretField} must not be sent before submission`);
    }

    const savedAnswers = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/answers`, {
        method: 'PUT', headers: authHeaders(userA.cookie), body: JSON.stringify({ answers: { 'q-1': 'Correct 1' } })
    });
    assert.equal(savedAnswers.status, 200);
    const activeSnapshot = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userA.cookie } })).json();
    assert.equal(activeSnapshot.data.activeAttempt.attemptId, attempt.attemptId);
    assert.deepEqual(activeSnapshot.data.activeAttempt.answers, { 'q-1': 'Correct 1' });
    assert.equal(JSON.stringify(activeSnapshot.data.activeAttempt).includes('correctAnswer'), false);
    const crossUserAnswerSave = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/answers`, {
        method: 'PUT', headers: authHeaders(userB.cookie), body: JSON.stringify({ answers: { 'q-1': 'Correct 1' } })
    });
    assert.equal(crossUserAnswerSave.status, 404);

    const userAData = await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userA.cookie } });
    assert.equal(userAData.status, 200);
    assert.equal((await userAData.json()).data.testHistory.length, 0);

    const crossUserRead = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}`, { headers: { Cookie: userB.cookie } });
    assert.equal(crossUserRead.status, 404);
    const idorRoute = await fetch(`${baseUrl}/api/users/${userA.userId}/progress`, { headers: { Cookie: userB.cookie } });
    assert.equal(idorRoute.status, 404);

    const answers = Array.from({ length: 9 }, (_, index) => ({
        questionId: `q-${index + 1}`,
        selectedAnswer: index === 1 || index === 5 ? `Wrong A ${index + 1}` : `Correct ${index + 1}`
    }));
    const submit = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/submit`, {
        method: 'POST', headers: authHeaders(userA.cookie), body: JSON.stringify({ answers })
    });
    assert.equal(submit.status, 200);
    const result = (await submit.json()).result;
    assert.deepEqual([result.correct, result.incorrect, result.unanswered, result.total, result.accuracy], [7, 2, 1, 10, 70]);
    assert.equal(result.questions[0].correctAnswer, 'Correct 1');

    const duplicateSubmit = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/submit`, {
        method: 'POST', headers: authHeaders(userA.cookie), body: JSON.stringify({ answers: [] })
    });
    assert.equal((await duplicateSubmit.json()).result.attemptId, result.attemptId);
    const saveAfterSubmit = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/answers`, {
        method: 'PUT', headers: authHeaders(userA.cookie), body: JSON.stringify({ answers: {} })
    });
    assert.equal(saveAfterSubmit.status, 409);
    const updatedA = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userA.cookie } })).json();
    const untouchedB = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userB.cookie } })).json();
    assert.equal(updatedA.data.testHistory.length, 1);
    assert.equal(updatedA.data.userProgress[getProgressKey('SI', 'Arithmetic', 'Percentages')].attempts, 1);
    assert.equal(untouchedB.data.testHistory.length, 0);
    assert.deepEqual(untouchedB.data.userProgress, {});
});

test('SI and Constable submissions preserve independent progress when switching roles', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Candidate', 'role-isolation@example.test');
    const siKey = getProgressKey('SI', 'Arithmetic', 'Percentages');
    const constableKey = getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages');

    await completeAttempt(baseUrl, user.cookie, 'SI', 8);
    let progress = dataStore.records.get(user.user.userId).userProgress;
    assert.equal(progress[siKey].bestScore, 8);
    assert.equal(progress[siKey].attempts, 1);
    assert.equal(progress[constableKey], undefined);
    const savedSiProgress = structuredClone(progress[siKey]);

    assert.equal((await switchExam(baseUrl, user.cookie, 'CONSTABLE')).status, 200);
    await completeAttempt(baseUrl, user.cookie, 'CONSTABLE', 9);
    progress = dataStore.records.get(user.user.userId).userProgress;
    assert.deepEqual(progress[siKey], savedSiProgress);
    assert.equal(progress[siKey].bestScore, 8);
    assert.equal(progress[siKey].attempts, 1);
    assert.equal(progress[constableKey].bestScore, 9);
    assert.equal(progress[constableKey].attempts, 1);
    assert.equal(progress[constableKey].totalQuestions, 10);

    assert.equal((await switchExam(baseUrl, user.cookie, 'SI')).status, 200);
    assert.equal((await switchExam(baseUrl, user.cookie, 'CONSTABLE')).status, 200);
    progress = (await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: user.cookie } })).json()).data.userProgress;
    assert.equal(progress[siKey].bestScore, 8);
    assert.equal(progress[constableKey].bestScore, 9);
});

test('a legacy untagged progress record is assigned to the account exam before a role switch', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Candidate', 'legacy-role-isolation@example.test');
    dataStore.records.get(user.user.userId).userProgress.Percentages = {
        topic: 'Percentages', subject: 'Arithmetic', attempts: 1, bestScore: 7, accuracy: 70
    };

    const switched = await switchExam(baseUrl, user.cookie, 'CONSTABLE');
    assert.equal(switched.status, 200);
    const progress = dataStore.records.get(user.user.userId).userProgress;
    assert.equal(progress[getProgressKey('SI', 'Arithmetic', 'Percentages')].bestScore, 7);
    assert.equal(progress[getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages')], undefined);
});

test('level unlock progression stays independent for SI and Constable', async (context) => {
    const { server, baseUrl, dataStore } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Candidate', 'role-level-isolation@example.test');
    const siKey = getProgressKey('SI', 'Arithmetic', 'Percentages');
    const constableKey = getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages');

    await completeAttempt(baseUrl, user.cookie, 'SI', 8);
    await switchExam(baseUrl, user.cookie, 'CONSTABLE');
    await completeAttempt(baseUrl, user.cookie, 'CONSTABLE', 7);
    const progress = dataStore.records.get(user.user.userId).userProgress;
    assert.equal(progress[siKey].level, 'Intermediate');
    assert.equal(progress[constableKey].level, 'Beginner');
});

test('test generation rejects non-syllabus context and protected data requires a session', async (context) => {
    const { server, baseUrl } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const unauthorized = await fetch(`${baseUrl}/api/me/data`);
    assert.equal(unauthorized.status, 401);
    const user = await signUp(baseUrl, 'Candidate', 'candidate@example.test');
    const invalid = await fetch(`${baseUrl}/api/tests`, {
        method: 'POST',
        headers: { ...authHeaders(user.cookie), 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ exam: 'SI', subject: 'Arithmetic', topic: 'Not in syllabus', difficulty: 'Beginner' })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_TEST_CONTEXT');
});

test('User A and User B retain independent 15-test and 50-test histories across login', async (context) => {
    const { server, baseUrl } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const userA = await signUp(baseUrl, 'Candidate A', 'multi-a@example.test');
    const userB = await signUp(baseUrl, 'Candidate B', 'multi-b@example.test');

    const completeAttempts = async (user, count, correctCount) => {
        for (let index = 0; index < count; index += 1) {
            const create = await fetch(`${baseUrl}/api/tests`, {
                method: 'POST',
                headers: { ...authHeaders(user.cookie), 'Idempotency-Key': randomUUID() },
                body: JSON.stringify({ exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner' })
            });
            const { attempt } = await create.json();
            assert.equal(create.status, 201);
            const answers = Array.from({ length: 10 }, (_, questionIndex) => ({
                questionId: `q-${questionIndex + 1}`,
                selectedAnswer: questionIndex < correctCount ? `Correct ${questionIndex + 1}` : `Wrong A ${questionIndex + 1}`
            }));
            const submit = await fetch(`${baseUrl}/api/tests/${attempt.attemptId}/submit`, {
                method: 'POST', headers: authHeaders(user.cookie), body: JSON.stringify({ answers })
            });
            assert.equal(submit.status, 200);
            const { result } = await submit.json();
            assert.equal(result.accuracy, correctCount * 10);
        }
    };

    await completeAttempts(userA, 15, 5);
    await completeAttempts(userB, 50, 8);
    const dataA = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userA.cookie } })).json();
    const dataB = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: userB.cookie } })).json();
    assert.equal(dataA.data.testHistory.length, 15);
    assert.equal(Math.round(dataA.data.testHistory.reduce((sum, attempt) => sum + attempt.accuracy, 0) / 15), 50);
    assert.equal(dataB.data.testHistory.length, 50);
    assert.equal(Math.round(dataB.data.testHistory.reduce((sum, attempt) => sum + attempt.accuracy, 0) / 50), 80);

    const logoutA = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST', headers: { Origin: 'https://frontend.example.test', Cookie: userA.cookie }
    });
    assert.equal(logoutA.status, 200);
    const loginA = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: 'https://frontend.example.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'multi-a@example.test', password: 'integration-test-password' })
    });
    assert.equal(loginA.status, 200);
    const cookieA = loginA.headers.get('set-cookie').split(';')[0];
    const restoredA = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: cookieA } })).json();
    assert.equal(restoredA.data.testHistory.length, 15);
    const userBAttemptIds = new Set(dataB.data.testHistory.map((attempt) => attempt.attemptId));
    assert.equal(restoredA.data.testHistory.some((attempt) => userBAttemptIds.has(attempt.attemptId)), false);
});

test('planner writes reject stale revisions instead of overwriting newer server data', async (context) => {
    const { server, baseUrl } = await createServer();
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const user = await signUp(baseUrl, 'Planner Candidate', 'planner@example.test');
    const plannerData = { examType: 'SI', generatedAt: null, summary: {}, topicMetrics: [], schedule: [], aiScheduleDailyMinutes: 240 };
    const firstWrite = await fetch(`${baseUrl}/api/me/planner`, {
        method: 'PUT', headers: authHeaders(user.cookie), body: JSON.stringify({ plannerData, expectedRevision: 0 })
    });
    assert.equal(firstWrite.status, 200);
    assert.equal((await firstWrite.json()).plannerRevision, 1);

    const staleWrite = await fetch(`${baseUrl}/api/me/planner`, {
        method: 'PUT', headers: authHeaders(user.cookie), body: JSON.stringify({ plannerData, expectedRevision: 0 })
    });
    assert.equal(staleWrite.status, 409);
    assert.equal((await staleWrite.json()).code, 'DATA_CONFLICT');
    const saved = await (await fetch(`${baseUrl}/api/me/data`, { headers: { Cookie: user.cookie } })).json();
    assert.equal(saved.data.plannerRevision, 1);
    assert.equal(saved.data.plannerData.aiScheduleDailyMinutes, 240);
});
