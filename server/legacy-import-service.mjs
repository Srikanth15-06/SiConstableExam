import { createHash, pbkdf2 as pbkdf2Callback, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SUBJECT_TOPICS, EXAM_TYPES } from '../frontend/src/syllabus.js';

const pbkdf2 = promisify(pbkdf2Callback);
const LEGACY_MEMBER_ID = /^member_\d{13}_[a-z\d]{6}$/i;
const LEGACY_ATTEMPT_ID = /^[a-z\d_-]{1,80}$/i;
const EMAIL = /^\S+@\S+\.\S+$/;
const DIFFICULTIES = new Set(['Beginner', 'Intermediate', 'Expert', 'Pro']);
const PROGRESS_LEVELS = new Set(['Beginner', 'Intermediate', 'Expert', 'Pro']);
const LEGACY_HISTORY_STATUSES = new Set(['LEVEL PASSED', 'PRACTICE REQUIRED']);
const MAX_RECORD_BYTES = 700_000;
const MAX_HISTORY = 500;
const MAX_QUESTIONS_PER_ATTEMPT = 10;
const MAX_PLANNER_TASKS = 1000;
const MAX_TOPICS = Object.values(SUBJECT_TOPICS).reduce((count, topics) => count + topics.length, 0);
const VALID_TOPICS = new Set(Object.values(SUBJECT_TOPICS).flat());
const LEGACY_MEMBER_FIELDS = new Set([
    'id', 'name', 'email', 'exam', 'passwordSalt', 'passwordHash', 'userProgress',
    'testHistory', 'seenQuestionCount', 'testAttemptCounter', 'plannerData'
]);
const SUBJECTS_BY_TOPIC = new Map();

for (const [subject, topics] of Object.entries(SUBJECT_TOPICS)) {
    for (const topic of topics) {
        const subjects = SUBJECTS_BY_TOPIC.get(topic) || [];
        subjects.push(subject);
        SUBJECTS_BY_TOPIC.set(topic, subjects);
    }
}

export class LegacyImportError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'LegacyImportError';
        this.code = code;
        this.status = status;
    }
}

function invalidRecord() {
    return new LegacyImportError('INVALID_LEGACY_RECORD', 'This saved account record is invalid or unsupported. Your browser copy has not been changed.');
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedString(value, maxLength, { required = false } = {}) {
    if (typeof value !== 'string') return required ? null : '';
    const normalized = value.normalize('NFKC').trim();
    if ((required && !normalized) || normalized.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) return null;
    return normalized;
}

function boundedNumber(value, min, max, { integer = false } = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return null;
    return value;
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sanitizeProgress(value) {
    if (!isRecord(value) || Object.keys(value).length > MAX_TOPICS) throw invalidRecord();
    const progress = {};
    for (const [topic, entry] of Object.entries(value)) {
        if (!VALID_TOPICS.has(topic) || !isRecord(entry)) throw invalidRecord();
        const level = boundedString(entry.level, 24, { required: true });
        const bestScore = boundedNumber(entry.bestScore, 0, 10, { integer: true });
        const attempts = boundedNumber(entry.attempts, 0, 1_000_000, { integer: true });
        const accuracy = boundedNumber(entry.accuracy, 0, 100);
        if (!PROGRESS_LEVELS.has(level) || bestScore === null || attempts === null || accuracy === null) throw invalidRecord();
        progress[topic] = {
            topic,
            subject: SUBJECTS_BY_TOPIC.get(topic)?.length === 1 ? SUBJECTS_BY_TOPIC.get(topic)[0] : null,
            level,
            bestScore,
            attempts,
            accuracy,
            verified: false
        };
    }
    return progress;
}

function sanitizeQuestionDetail(question) {
    if (!isRecord(question)) throw invalidRecord();
    const questionId = boundedString(question.questionId, 100, { required: true });
    const questionText = boundedString(question.question, 2000, { required: true });
    const userAnswer = boundedString(question.userAnswer, 500);
    const correctAnswer = boundedString(question.correctAnswer, 500, { required: true });
    const explanation = boundedString(question.explanation, 3000);
    const shortcut = boundedString(question.shortcut, 2000);
    const status = boundedString(question.status, 16, { required: true });
    if (!questionId || !questionText || userAnswer === null || !correctAnswer || explanation === null || shortcut === null
        || !['CORRECT', 'INCORRECT', 'UNANSWERED'].includes(status) || typeof question.isCorrect !== 'boolean'
        || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 8) throw invalidRecord();
    const options = question.options.map((option) => boundedString(option, 500, { required: true }));
    if (options.some((option) => !option)) throw invalidRecord();
    return { questionId, question: questionText, options, userAnswer, correctAnswer, isCorrect: question.isCorrect, status, explanation, shortcut };
}

function sanitizeAnswerKey(value) {
    if (!Array.isArray(value) || value.length > MAX_QUESTIONS_PER_ATTEMPT) throw invalidRecord();
    return value.map((entry) => {
        if (!isRecord(entry)) throw invalidRecord();
        const questionId = boundedString(entry.questionId, 100, { required: true });
        const correctAnswer = boundedString(entry.correctAnswer, 500, { required: true });
        if (!questionId || !correctAnswer) throw invalidRecord();
        return { questionId, correctAnswer };
    });
}

function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidDuration(value) {
    const match = value.match(/^(\d{1,3}):(\d{2})$/);
    return Boolean(match && Number(match[2]) < 60);
}

function sanitizeHistory(value) {
    if (!Array.isArray(value) || value.length > MAX_HISTORY) throw invalidRecord();
    return value.map((attempt) => {
        if (!isRecord(attempt)) throw invalidRecord();
        const attemptId = boundedString(attempt.id, 80, { required: true });
        const exam = boundedString(attempt.exam, 24, { required: true });
        const subject = boundedString(attempt.subject, 80, { required: true });
        const topic = boundedString(attempt.topic, 120, { required: true });
        const difficulty = boundedString(attempt.difficulty, 24, { required: true });
        const status = boundedString(attempt.status, 40, { required: true });
        const date = boundedString(attempt.date, 10, { required: true });
        const timeTaken = boundedString(attempt.timeTaken, 16, { required: true });
        const score = boundedNumber(attempt.score, 0, 10, { integer: true });
        const total = boundedNumber(attempt.total, 1, 10, { integer: true });
        const correct = boundedNumber(attempt.correct, 0, 10, { integer: true });
        const incorrect = boundedNumber(attempt.incorrect, 0, 10, { integer: true });
        const unanswered = boundedNumber(attempt.unanswered, 0, 10, { integer: true });
        const percentage = boundedNumber(attempt.percentage, 0, 100);
        const accuracy = boundedNumber(attempt.accuracy, 0, 100);
        if (!attemptId || !LEGACY_ATTEMPT_ID.test(attemptId) || !EXAM_TYPES.includes(exam)
            || !Object.hasOwn(SUBJECT_TOPICS, subject) || !SUBJECT_TOPICS[subject].includes(topic)
            || !DIFFICULTIES.has(difficulty) || !LEGACY_HISTORY_STATUSES.has(status)
            || !date || !isValidDate(date) || !timeTaken || !isValidDuration(timeTaken)
            || score === null || total === null || correct === null || incorrect === null || unanswered === null
            || percentage === null || accuracy === null || total !== correct + incorrect + unanswered || score !== correct
            || percentage !== accuracy || !Array.isArray(attempt.questions) || attempt.questions.length !== total
            || attempt.questions.length > MAX_QUESTIONS_PER_ATTEMPT) throw invalidRecord();
        const questions = attempt.questions.map(sanitizeQuestionDetail);
        const answerKey = sanitizeAnswerKey(attempt.answerKey);
        if (new Set(answerKey.map((entry) => entry.questionId)).size !== answerKey.length) throw invalidRecord();
        return {
            id: attemptId,
            exam,
            subject,
            topic,
            difficulty,
            score,
            total,
            correct,
            incorrect,
            unanswered,
            percentage,
            accuracy,
            status,
            date,
            timeTaken,
            questions,
            answerKey,
            legacy: true,
            verified: false
        };
    });
}

function sanitizeScalarObject(value, maxEntries, maxText = 500) {
    if (!isRecord(value) || Object.keys(value).length > maxEntries) throw invalidRecord();
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!/^[\w -]{1,80}$/.test(key)) throw invalidRecord();
        if (typeof entry === 'string') {
            const text = boundedString(entry, maxText);
            if (text === null) throw invalidRecord();
            output[key] = text;
        } else if (typeof entry === 'number' && Number.isFinite(entry)) output[key] = entry;
        else if (typeof entry === 'boolean' || entry === null) output[key] = entry;
        else throw invalidRecord();
    }
    return output;
}

function sanitizePlanner(value) {
    if (!isRecord(value) || !EXAM_TYPES.includes(value.examType) || !Array.isArray(value.schedule)
        || value.schedule.length > MAX_PLANNER_TASKS || !Array.isArray(value.topicMetrics)
        || value.topicMetrics.length > MAX_TOPICS) throw invalidRecord();
    const generatedAt = value.generatedAt === null ? null : boundedString(value.generatedAt, 40);
    if (generatedAt === null && value.generatedAt !== null) throw invalidRecord();
    const schedule = value.schedule.map((task) => {
        if (!isRecord(task)) throw invalidRecord();
        const id = boundedString(task.id, 100, { required: true });
        const subject = boundedString(task.subject, 80, { required: true });
        const topic = boundedString(task.topic, 120, { required: true });
        const date = boundedString(task.date, 10, { required: true });
        const startTime = boundedString(task.startTime, 5, { required: true });
        const endTime = boundedString(task.endTime, 5, { required: true });
        const duration = boundedNumber(task.duration, 1, 1440, { integer: true });
        const priority = boundedString(task.priority, 16, { required: true });
        const reason = boundedString(task.reason, 1000);
        const notes = boundedString(task.notes, 500);
        const taskExam = task.examType === undefined ? value.examType : boundedString(task.examType, 24, { required: true });
        const taskStatus = task.status === undefined ? 'scheduled' : boundedString(task.status, 16, { required: true });
        if (!id || !Object.hasOwn(SUBJECT_TOPICS, subject) || !SUBJECT_TOPICS[subject].includes(topic)
            || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !startTime || !/^\d{2}:\d{2}$/.test(startTime)
            || !endTime || !/^\d{2}:\d{2}$/.test(endTime) || duration === null
            || !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'COMPLETED'].includes(priority)
            || reason === null || notes === null || !EXAM_TYPES.includes(taskExam)
            || !['scheduled', 'completed', 'cancelled'].includes(taskStatus) || typeof task.autoGenerated !== 'boolean') throw invalidRecord();
        return {
            id,
            subject,
            topic,
            date,
            startTime,
            endTime,
            duration,
            priority,
            status: taskStatus,
            examType: taskExam,
            reason,
            notes,
            autoGenerated: task.autoGenerated
        };
    });
    const topicMetrics = value.topicMetrics.map((metric) => sanitizeScalarObject(metric, 24, 240));
    return {
        examType: value.examType,
        generatedAt,
        summary: sanitizeScalarObject(value.summary, 40, 240),
        topicMetrics,
        schedule
    };
}

export async function verifyLegacyPassword(password, saltHex, hashHex) {
    if (typeof password !== 'string' || password.length < 1 || password.length > 128
        || typeof saltHex !== 'string' || !/^[a-f\d]{32}$/i.test(saltHex)
        || typeof hashHex !== 'string' || !/^[a-f\d]{64}$/i.test(hashHex)) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await pbkdf2(password, salt, 120_000, 32, 'sha256');
    return timingSafeEqual(actual, expected);
}

export function sanitizeLegacyMember(record) {
    if (!isRecord(record)) throw invalidRecord();
    if (Object.keys(record).some((key) => !LEGACY_MEMBER_FIELDS.has(key))) throw invalidRecord();
    let byteLength;
    try {
        byteLength = Buffer.byteLength(JSON.stringify(record), 'utf8');
    } catch {
        throw invalidRecord();
    }
    if (byteLength > MAX_RECORD_BYTES) throw new LegacyImportError('LEGACY_RECORD_TOO_LARGE', 'This saved account is too large to import safely. Your browser copy has not been changed.', 413);

    const legacyId = boundedString(record.id, 64, { required: true });
    const name = boundedString(record.name, 120, { required: true });
    const email = boundedString(record.email, 254, { required: true })?.toLowerCase();
    const exam = boundedString(record.exam, 24, { required: true });
    if (!legacyId || !LEGACY_MEMBER_ID.test(legacyId) || !name || !email || !EMAIL.test(email) || !EXAM_TYPES.includes(exam)
        || typeof record.passwordSalt !== 'string' || !/^[a-f\d]{32}$/i.test(record.passwordSalt)
        || typeof record.passwordHash !== 'string' || !/^[a-f\d]{64}$/i.test(record.passwordHash)) throw invalidRecord();

    const userProgress = sanitizeProgress(record.userProgress);
    const testHistory = sanitizeHistory(record.testHistory);
    const plannerData = sanitizePlanner(record.plannerData);
    const seenQuestionCount = boundedNumber(record.seenQuestionCount, 0, 10_000_000, { integer: true });
    const testAttemptCounter = boundedNumber(record.testAttemptCounter, 0, 1_000_000, { integer: true });
    if (seenQuestionCount === null || testAttemptCounter === null) throw invalidRecord();

    const identityAndState = canonicalize({
        id: legacyId,
        name,
        email,
        exam,
        userProgress,
        testHistory,
        seenQuestionCount,
        testAttemptCounter,
        plannerData
    });
    const fingerprint = createHash('sha256').update(JSON.stringify(identityAndState)).digest('hex');
    return {
        legacyId,
        name,
        email,
        exam,
        passwordSalt: record.passwordSalt.toLowerCase(),
        passwordHash: record.passwordHash.toLowerCase(),
        fingerprint,
        userProgress,
        testHistory,
        seenQuestionCount,
        testAttemptCounter,
        plannerData
    };
}

export function createLegacyUserData(userId, legacy, importedAt = new Date().toISOString()) {
    if (typeof userId !== 'string' || !/^usr_[a-f\d-]{36}$/i.test(userId)) throw new TypeError('A server-generated user ID is required.');
    const plannerData = {
        ...legacy.plannerData,
        schedule: legacy.plannerData.schedule.map((task) => ({ ...task, userId }))
    };
    return {
        schemaVersion: 1,
        revision: 0,
        userId,
        plannerRevision: 0,
        profile: { name: legacy.name, email: legacy.email },
        exam: legacy.exam,
        userProgress: {},
        testHistory: [],
        attempts: [],
        seenQuestionCount: 0,
        testAttemptCounter: 0,
        plannerData,
        legacyImport: { version: 1, fingerprint: legacy.fingerprint, importedAt },
        legacyArchive: {
            verified: false,
            importedAt,
            legacyMemberId: legacy.legacyId,
            userProgress: legacy.userProgress,
            testHistory: legacy.testHistory,
            plannerData: legacy.plannerData,
            seenQuestionCount: legacy.seenQuestionCount,
            testAttemptCounter: legacy.testAttemptCounter
        },
        createdAt: importedAt,
        updatedAt: importedAt
    };
}

export function createLegacyImportId() {
    return `usr_${randomUUID()}`;
}