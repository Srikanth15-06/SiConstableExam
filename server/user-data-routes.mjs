import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Router } from 'express';
import { calculateTestResult } from '../frontend/src/test-results.js';
import { getLegacyTopicProgress, getProgressKey, normalizeUserProgress } from '../frontend/src/planner-utils.js';
import { EXAM_TYPES, SUBJECT_TOPICS } from '../frontend/src/syllabus.js';
import { generateQuestions } from './ai-service.mjs';
import { createAuthenticationMiddleware } from './auth-service.mjs';

const DIFFICULTIES = new Set(['Beginner', 'Intermediate', 'Expert', 'Pro']);
const MAX_PLANNER_BYTES = 250_000;
const MAX_PLANNER_TASKS = 1000;
const passThrough = (_req, _res, next) => next();

function routeError(res, status, code, message) {
    res.status(status).json({ success: false, error: true, code, message });
}

function safeStorageFailure(res, requestId, error, category) {
    console.error(JSON.stringify({ requestId, category, code: error.code || 'DRIVE_DATA_STORAGE_FAILED' }));
    routeError(res, 503, 'USER_DATA_UNAVAILABLE', 'Your saved data is temporarily unavailable. Nothing was cleared. Please retry.');
}

function normalizeExam(exam) {
    if (exam === 'SI' || exam === 'TS SI') return { local: 'SI', provider: 'TS SI' };
    if (exam === 'CONSTABLE' || exam === 'TS Constable') return { local: 'CONSTABLE', provider: 'TS Constable' };
    return null;
}

function publicQuestion(question) {
    const safe = {};
    for (const [key, value] of Object.entries(question || {})) {
        if (/correct.?answer|answer.?key|solution.?key|^explanation$|^shortcut$/i.test(key)) continue;
        safe[key] = value;
    }
    safe.questionId = String(question.id || question.questionId || '');
    return safe;
}

function publicAttempt(attempt) {
    if (!attempt) return null;
    return {
        attemptId: attempt.attemptId,
        exam: attempt.exam,
        subject: attempt.subject,
        topic: attempt.topic,
        difficulty: attempt.difficulty,
        startedAt: attempt.startedAt,
        status: attempt.status,
        questions: attempt.status === 'submitted'
            ? attempt.result?.details || []
            : (attempt.questions || []).map(publicQuestion),
        ...(attempt.status === 'in_progress' ? { answers: attempt.answers || {} } : {}),
        ...(attempt.status === 'submitted' ? { result: attempt.result, submittedAt: attempt.submittedAt } : {})
    };
}

function newestActiveAttempt(attempts) {
    return (Array.isArray(attempts) ? attempts : [])
        .filter((attempt) => attempt && typeof attempt === 'object' && attempt.status === 'in_progress')
        .sort((left, right) => {
            const leftTime = Date.parse(left.startedAt);
            const rightTime = Date.parse(right.startedAt);
            const normalizedLeftTime = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
            const normalizedRightTime = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
            if (normalizedLeftTime !== normalizedRightTime) return normalizedLeftTime > normalizedRightTime ? -1 : 1;

            const leftId = String(left.attemptId || '');
            const rightId = String(right.attemptId || '');
            if (leftId !== rightId) return leftId > rightId ? -1 : 1;

            const leftSnapshot = JSON.stringify(left);
            const rightSnapshot = JSON.stringify(right);
            return leftSnapshot === rightSnapshot ? 0 : leftSnapshot > rightSnapshot ? -1 : 1;
        })[0] || null;
}

function sanitizePlanner(value, userId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    let size;
    try {
        size = Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        return null;
    }
    if (size > MAX_PLANNER_BYTES || !Array.isArray(value.schedule) || value.schedule.length > MAX_PLANNER_TASKS) return null;
    const schedule = [];
    for (const task of value.schedule) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
        const subject = String(task.subject || '').trim();
        const topic = String(task.topic || '').trim();
        const date = String(task.date || '').trim();
        const startTime = String(task.startTime || '').trim();
        const endTime = String(task.endTime || '').trim();
        if (!Object.hasOwn(SUBJECT_TOPICS, subject) || !SUBJECT_TOPICS[subject].includes(topic)
            || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) return null;
        schedule.push({
            id: String(task.id || randomUUID()).slice(0, 100),
            userId,
            examType: EXAM_TYPES.includes(task.examType) ? task.examType : value.examType,
            subject,
            topic,
            date,
            startTime,
            endTime,
            duration: Math.max(1, Math.min(1440, Number(task.duration) || 60)),
            priority: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'COMPLETED'].includes(task.priority) ? task.priority : 'MEDIUM',
            status: ['scheduled', 'completed', 'cancelled'].includes(task.status) ? task.status : 'scheduled',
            notes: String(task.notes || '').slice(0, 500),
            reason: String(task.reason || '').slice(0, 1000),
            autoGenerated: Boolean(task.autoGenerated)
        });
    }
    return {
        examType: EXAM_TYPES.includes(value.examType) ? value.examType : 'SI',
        generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt.slice(0, 40) : null,
        summary: value.summary && typeof value.summary === 'object' && !Array.isArray(value.summary) ? value.summary : {},
        topicMetrics: Array.isArray(value.topicMetrics) ? value.topicMetrics.slice(0, 1000) : [],
        schedule,
        aiScheduleDailyMinutes: Number.isInteger(value.aiScheduleDailyMinutes)
            ? Math.max(30, Math.min(720, value.aiScheduleDailyMinutes))
            : 180
    };
}

export function createUserDataRouter({ dataStore, sessions, generateQuestionSet = generateQuestions, rateLimiters = {}, allowedOrigins = new Set() }) {
    const router = Router();
    const authenticate = createAuthenticationMiddleware(sessions);
    const requireTrustedOrigin = (req, res, next) => {
        let origin;
        try {
            origin = req.get('origin') ? new URL(req.get('origin')).origin : '';
        } catch {
            origin = '';
        }
        if (!origin || !allowedOrigins.has(origin)) {
            routeError(res, 403, 'CSRF_ORIGIN_DENIED', 'This request origin is not allowed. Reload the application and try again.');
            return;
        }
        next();
    };

    router.get('/me/data', authenticate, rateLimiters.userData || passThrough, async (req, res) => {
        try {
            const record = await dataStore.getUserData(req.authUserId);
            const activeAttempt = newestActiveAttempt(record.attempts);
            res.json({
                success: true,
                data: {
                    profile: record.profile,
                    exam: record.exam,
                    plannerRevision: Number(record.plannerRevision) || 0,
                    activeAttempt: publicAttempt(activeAttempt),
                    userProgress: record.userProgress,
                    testHistory: record.testHistory,
                    legacyArchive: record.legacyArchive || null,
                    seenQuestionCount: record.seenQuestionCount,
                    testAttemptCounter: record.testAttemptCounter,
                    plannerData: record.plannerData
                }
            });
        } catch (error) {
            safeStorageFailure(res, randomUUID(), error, 'user-data-read');
        }
    });

    router.patch('/me/profile', authenticate, requireTrustedOrigin, rateLimiters.userData || passThrough, async (req, res) => {
        const name = typeof req.body?.name === 'string' ? req.body.name.normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : null;
        const exam = normalizeExam(req.body?.exam);
        if (!name || name.length < 1 || !exam) {
            routeError(res, 400, 'INVALID_PROFILE', 'Provide a valid name and exam type.');
            return;
        }
        try {
            const currentData = await dataStore.getUserData(req.authUserId);
            const normalizedProgress = normalizeUserProgress(currentData.userProgress, currentData.exam, currentData.testHistory, SUBJECT_TOPICS);
            if (!isDeepStrictEqual(currentData.userProgress || {}, normalizedProgress)) {
                await dataStore.updateUserData(req.authUserId, (record) => {
                    record.userProgress = normalizeUserProgress(record.userProgress, record.exam, record.testHistory, SUBJECT_TOPICS);
                    return record;
                });
            }
            const user = await dataStore.updateProfile(req.authUserId, { name, exam: exam.local });
            const record = await dataStore.getUserData(req.authUserId);
            res.json({ success: true, profile: record.profile, exam: record.exam, user });
        } catch (error) {
            safeStorageFailure(res, randomUUID(), error, 'profile-update');
        }
    });

    router.put('/me/planner', authenticate, requireTrustedOrigin, rateLimiters.userData || passThrough, async (req, res) => {
        const plannerData = sanitizePlanner(req.body?.plannerData, req.authUserId);
        const expectedRevision = req.body?.expectedRevision;
        if (!plannerData || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
            routeError(res, 400, 'INVALID_PLANNER', 'Planner data is invalid or exceeds the allowed size.');
            return;
        }
        try {
            const record = await dataStore.updateUserData(req.authUserId, (record) => {
                const currentRevision = Number(record.plannerRevision) || 0;
                if (currentRevision !== expectedRevision) {
                    throw Object.assign(new Error('planner revision changed'), { code: 'DRIVE_DATA_CONFLICT' });
                }
                record.plannerData = plannerData;
                record.plannerRevision = currentRevision + 1;
                return record;
            });
            res.json({ success: true, plannerData, plannerRevision: record.plannerRevision });
        } catch (error) {
            if (error.code === 'DRIVE_DATA_CONFLICT') {
                routeError(res, 409, 'DATA_CONFLICT', 'Your planner changed elsewhere. Reload the saved version before continuing.');
                return;
            }
            safeStorageFailure(res, randomUUID(), error, 'planner-update');
        }
    });

    router.post('/tests', authenticate, requireTrustedOrigin, rateLimiters.userData || passThrough, rateLimiters.createTest || passThrough, async (req, res) => {
        const exam = normalizeExam(req.body?.exam);
        const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
        const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
        const difficulty = typeof req.body?.difficulty === 'string' ? req.body.difficulty.trim() : '';
        if (!exam || !Object.hasOwn(SUBJECT_TOPICS, subject) || !SUBJECT_TOPICS[subject].includes(topic) || !DIFFICULTIES.has(difficulty)) {
            routeError(res, 400, 'INVALID_TEST_CONTEXT', 'Choose a valid exam, subject, syllabus topic, and difficulty.');
            return;
        }
        const idempotencyKey = String(req.get('idempotency-key') || '').trim();
        if (!/^[a-f\d-]{36}$/i.test(idempotencyKey)) {
            routeError(res, 400, 'INVALID_IDEMPOTENCY_KEY', 'A valid test request identifier is required.');
            return;
        }

        try {
            const beforeGeneration = await dataStore.getUserData(req.authUserId);
            const priorAttempt = beforeGeneration.attempts.find((attempt) => attempt.idempotencyKey === idempotencyKey);
            if (priorAttempt) {
                res.json({ success: true, attempt: publicAttempt(priorAttempt) });
                return;
            }
            const activeAttempt = newestActiveAttempt(beforeGeneration.attempts);
            if (activeAttempt) {
                res.json({ success: true, attempt: publicAttempt(activeAttempt) });
                return;
            }
            const previousQuestionSignatures = beforeGeneration.testHistory
                .flatMap((attempt) => (attempt.questions || []).map((question) => question.question))
                .filter(Boolean)
                .slice(0, 100);
            const questions = await generateQuestionSet({
                exam: exam.provider,
                subject,
                topic,
                difficulty,
                count: 10,
                attemptSeed: beforeGeneration.testAttemptCounter + 1,
                previousQuestionSignatures
            });
            if (!Array.isArray(questions) || questions.length !== 10 || questions.some((question) => !question?.id || !question?.correctAnswer)) {
                routeError(res, 502, 'INVALID_QUESTION_SET', 'The generated test could not be validated. Please try again.');
                return;
            }
            const attemptId = randomUUID();
            const startedAt = new Date().toISOString();
            const attempt = {
                attemptId,
                idempotencyKey,
                userId: req.authUserId,
                exam: exam.local,
                subject,
                topic,
                difficulty,
                startedAt,
                status: 'in_progress',
                questions,
                answers: null,
                result: null,
                submittedAt: null
            };
            let persistedAttempt;
            let createdAttempt = false;
            const record = await dataStore.updateUserData(req.authUserId, (current) => {
                createdAttempt = false;
                const prior = current.attempts.find((item) => item.idempotencyKey === idempotencyKey);
                if (prior) {
                    persistedAttempt = prior;
                    return current;
                }
                const currentActiveAttempt = newestActiveAttempt(current.attempts);
                if (currentActiveAttempt) {
                    persistedAttempt = currentActiveAttempt;
                    return current;
                }
                current.attempts.push(attempt);
                current.testAttemptCounter = Math.max(Number(current.testAttemptCounter) || 0, beforeGeneration.testAttemptCounter + 1);
                current.seenQuestionCount = (Number(current.seenQuestionCount) || 0) + 10;
                persistedAttempt = attempt;
                createdAttempt = true;
                return current;
            });
            if (!record.attempts.some((item) => item.attemptId === persistedAttempt.attemptId)) {
                routeError(res, 503, 'TEST_STORAGE_UNAVAILABLE', 'The test could not be saved. Please retry.');
                return;
            }
            res.status(createdAttempt ? 201 : 200).json({ success: true, attempt: publicAttempt(persistedAttempt) });
        } catch (error) {
            safeStorageFailure(res, randomUUID(), error, 'test-create');
        }
    });

    router.get('/tests/:attemptId', authenticate, rateLimiters.userData || passThrough, async (req, res) => {
        try {
            const record = await dataStore.getUserData(req.authUserId);
            const attempt = record.attempts.find((item) => item.attemptId === req.params.attemptId);
            if (!attempt) {
                routeError(res, 404, 'ATTEMPT_NOT_FOUND', 'Test attempt was not found.');
                return;
            }
            res.json({ success: true, attempt: publicAttempt(attempt) });
        } catch (error) {
            safeStorageFailure(res, randomUUID(), error, 'test-read');
        }
    });

    router.put('/tests/:attemptId/answers', authenticate, requireTrustedOrigin, rateLimiters.userData || passThrough, async (req, res) => {
        const answers = req.body?.answers;
        if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length > 10) {
            routeError(res, 400, 'INVALID_ANSWERS', 'Test answers are invalid.');
            return;
        }
        try {
            let savedAnswers;
            await dataStore.updateUserData(req.authUserId, (record) => {
                const attempt = record.attempts.find((item) => item.attemptId === req.params.attemptId);
                if (!attempt) throw Object.assign(new Error('attempt missing'), { code: 'ATTEMPT_NOT_FOUND' });
                if (attempt.status !== 'in_progress') throw Object.assign(new Error('already submitted'), { code: 'ATTEMPT_ALREADY_SUBMITTED' });
                const questions = new Map(attempt.questions.map((question) => [question.id, question]));
                const safeAnswers = {};
                for (const [questionId, selectedAnswer] of Object.entries(answers)) {
                    const question = questions.get(questionId);
                    if (!question || typeof selectedAnswer !== 'string' || selectedAnswer.length > 500 || !question.options.includes(selectedAnswer)) {
                        throw Object.assign(new Error('invalid answer'), { code: 'INVALID_ANSWERS' });
                    }
                    safeAnswers[questionId] = selectedAnswer;
                }
                attempt.answers = safeAnswers;
                savedAnswers = safeAnswers;
                return record;
            });
            res.json({ success: true, answers: savedAnswers });
        } catch (error) {
            if (error.code === 'ATTEMPT_NOT_FOUND') {
                routeError(res, 404, 'ATTEMPT_NOT_FOUND', 'Test attempt was not found.');
                return;
            }
            if (error.code === 'INVALID_ANSWERS') {
                routeError(res, 400, 'INVALID_ANSWERS', 'One or more selected answers are invalid.');
                return;
            }
            if (error.code === 'ATTEMPT_ALREADY_SUBMITTED') {
                routeError(res, 409, error.code, 'This test has already been submitted.');
                return;
            }
            safeStorageFailure(res, randomUUID(), error, 'test-answer-save');
        }
    });

    router.post('/tests/:attemptId/submit', authenticate, requireTrustedOrigin, rateLimiters.userData || passThrough, rateLimiters.submitTest || passThrough, async (req, res) => {
        const inputAnswers = req.body?.answers;
        if (!Array.isArray(inputAnswers) || inputAnswers.length > 10) {
            routeError(res, 400, 'INVALID_ANSWERS', 'Submit up to ten selected answers.');
            return;
        }
        const answerMap = {};
        for (const answer of inputAnswers) {
            if (!answer || typeof answer.questionId !== 'string' || typeof answer.selectedAnswer !== 'string'
                || answer.selectedAnswer.length > 500 || Object.hasOwn(answerMap, answer.questionId)) {
                routeError(res, 400, 'INVALID_ANSWERS', 'One or more submitted answers are invalid.');
                return;
            }
            answerMap[answer.questionId] = answer.selectedAnswer;
        }

        try {
            let responseResult;
            await dataStore.updateUserData(req.authUserId, (record) => {
                const attempt = record.attempts.find((item) => item.attemptId === req.params.attemptId);
                if (!attempt) throw Object.assign(new Error('attempt missing'), { code: 'ATTEMPT_NOT_FOUND' });
                if (attempt.status === 'submitted') {
                    responseResult = attempt.result;
                    return record;
                }
                const questionById = new Map(attempt.questions.map((question) => [question.id, question]));
                for (const [questionId, selectedAnswer] of Object.entries(answerMap)) {
                    const question = questionById.get(questionId);
                    if (!question || !question.options.includes(selectedAnswer)) {
                        throw Object.assign(new Error('invalid answer'), { code: 'INVALID_ANSWERS' });
                    }
                }
                const result = calculateTestResult(attempt.questions, answerMap);
                result.details = result.details.map((detail) => ({ ...detail, id: detail.questionId }));
                const submittedAt = new Date();
                const startedAt = Date.parse(attempt.startedAt);
                const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(0, Math.floor((submittedAt.getTime() - startedAt) / 1000)) : 0;
                const durationSeconds = Math.min(600, elapsedSeconds);
                const isPassed = result.total === 10 && result.correct >= 8;
                const nextLevel = { Beginner: 'Intermediate', Intermediate: 'Expert', Expert: 'Pro', Pro: 'Pro' };
                record.userProgress ||= {};
                const progressKey = getProgressKey(attempt.exam, attempt.subject, attempt.topic);
                let previous = record.userProgress[progressKey];
                if (!previous) {
                    previous = getLegacyTopicProgress(record.userProgress, record.exam, attempt.exam, attempt.subject, attempt.topic, SUBJECT_TOPICS);
                    if (previous) delete record.userProgress[attempt.topic];
                }
                previous ||= { level: 'Beginner', bestScore: 0, attempts: 0, accuracy: 0 };
                const priorCount = Number(previous.attempts) || 0;
                const priorTotalQuestions = Number(previous.totalQuestions) || priorCount * result.total;
                const priorCorrectAnswers = Number(previous.correctAnswers)
                    || Math.round(((Number(previous.accuracy) || 0) / 100) * priorTotalQuestions);
                const totalQuestions = priorTotalQuestions + result.total;
                const correctAnswers = priorCorrectAnswers + result.correct;
                record.userProgress[progressKey] = {
                    exam: attempt.exam,
                    subject: attempt.subject,
                    topic: attempt.topic,
                    level: isPassed ? nextLevel[attempt.difficulty] : previous.level,
                    bestScore: Math.max(Number(previous.bestScore) || 0, result.correct),
                    attempts: priorCount + 1,
                    correctAnswers,
                    totalQuestions,
                    accuracy: totalQuestions ? Math.round((correctAnswers / totalQuestions) * 100) : 0
                };
                const formattedTime = `${String(Math.floor(durationSeconds / 60)).padStart(2, '0')}:${String(durationSeconds % 60).padStart(2, '0')}`;
                const completed = {
                    attemptId: attempt.attemptId,
                    exam: attempt.exam,
                    subject: attempt.subject,
                    topic: attempt.topic,
                    difficulty: attempt.difficulty,
                    score: result.correct,
                    total: result.total,
                    correct: result.correct,
                    incorrect: result.incorrect,
                    unanswered: result.unanswered,
                    percentage: result.percentage,
                    accuracy: result.accuracy,
                    status: isPassed ? 'LEVEL PASSED' : 'PRACTICE REQUIRED',
                    date: submittedAt.toISOString().slice(0, 10),
                    submittedAt: submittedAt.toISOString(),
                    timeTaken: formattedTime,
                    questions: result.details
                };
                attempt.status = 'submitted';
                attempt.submittedAt = completed.submittedAt;
                attempt.answers = answerMap;
                attempt.result = completed;
                record.testHistory.unshift(completed);
                responseResult = completed;
                return record;
            });
            res.json({ success: true, result: responseResult });
        } catch (error) {
            if (error.code === 'ATTEMPT_NOT_FOUND') {
                routeError(res, 404, 'ATTEMPT_NOT_FOUND', 'Test attempt was not found.');
                return;
            }
            if (error.code === 'INVALID_ANSWERS') {
                routeError(res, 400, 'INVALID_ANSWERS', 'One or more submitted answers are invalid.');
                return;
            }
            safeStorageFailure(res, randomUUID(), error, 'test-submit');
        }
    });

    return router;
}
