import { normalizeAnswer } from './test-results.js';
import { getProgressKey, resolveTopicWeightage } from './planner-utils.js';

function questionCorrect(question) {
    if (typeof question?.isCorrect === 'boolean') return question.isCorrect;
    if (question?.status) return question.status === 'CORRECT';
    const answer = normalizeAnswer(question?.userAnswer);
    return Boolean(answer && answer === normalizeAnswer(question?.correctAnswer));
}

function questionUnanswered(question) {
    if (question?.status) return question.status === 'UNANSWERED';
    return !normalizeAnswer(question?.userAnswer);
}

export function getMistakeNotebook(history = [], exam = 'SI') {
    return (Array.isArray(history) ? history : [])
        .filter((attempt) => attempt?.exam === exam)
        .flatMap((attempt) => (Array.isArray(attempt.questions) ? attempt.questions : [])
            .filter((question) => !questionCorrect(question))
            .map((question) => ({
                ...question,
                attemptId: attempt.attemptId || attempt.id,
                date: attempt.date || attempt.submittedAt?.slice(0, 10) || '',
                subject: question.subject || attempt.subject || '',
                topic: question.topic || attempt.topic || '',
                difficulty: attempt.difficulty || question.difficulty || '',
                answerStatus: question.status === 'UNANSWERED' || !normalizeAnswer(question.userAnswer) ? 'Unanswered' : 'Incorrect'
            })))
        .sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
}

export function getSpacedRevisionRecommendations(userProgress = {}, history = [], exam = 'SI', subjectTopics = {}, now = new Date()) {
    const latestByTopic = new Map();
    for (const attempt of Array.isArray(history) ? history : []) {
        if (attempt?.exam !== exam) continue;
        const groupedAttempt = new Map();
        for (const question of Array.isArray(attempt.questions) ? attempt.questions : []) {
            const subject = question.subject || attempt.subject;
            const topic = question.topic || attempt.topic;
            if (subject && topic && subjectTopics[subject]?.includes(topic)) {
                const key = getProgressKey(exam, subject, topic);
                const group = groupedAttempt.get(key) || { subject, topic, correct: 0, total: 0 };
                group.total += 1;
                if (questionCorrect(question)) group.correct += 1;
                groupedAttempt.set(key, group);
            }
        }
        for (const [key, group] of groupedAttempt) {
                const timestamp = Date.parse(attempt.submittedAt || attempt.date || '');
                const current = latestByTopic.get(key);
                if (!current || (Number.isFinite(timestamp) && timestamp > current.timestamp)) {
                    latestByTopic.set(key, {
                        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
                        accuracy: group.total ? Math.round((group.correct / group.total) * 100) : 0
                    });
                }
        }
        if (!attempt.questions?.length && attempt.subject && attempt.topic) {
            const key = getProgressKey(exam, attempt.subject, attempt.topic);
            const timestamp = Date.parse(attempt.submittedAt || attempt.date || '');
            const current = latestByTopic.get(key);
            if (!current || (Number.isFinite(timestamp) && timestamp > current.timestamp)) {
                latestByTopic.set(key, { timestamp: Number.isFinite(timestamp) ? timestamp : 0, accuracy: Number(attempt.accuracy) || 0 });
            }
        }
    }

    const topics = [];
    for (const [subject, list] of Object.entries(subjectTopics)) {
        for (const topic of list) {
            const progress = Object.values(userProgress || {}).find((item) => item?.exam === exam && item.subject === subject && item.topic === topic);
            const key = getProgressKey(exam, subject, topic);
            const historyMetric = latestByTopic.get(key);
            const attempted = Number(progress?.attempts) > 0 || Boolean(historyMetric);
            if (!attempted) continue;
            const accuracy = historyMetric ? historyMetric.accuracy : Number(progress?.accuracy) || 0;
            const intervalDays = accuracy < 50 ? 1 : accuracy < 70 ? 3 : accuracy < 85 ? 7 : 14;
            const lastTimestamp = historyMetric?.timestamp || Date.parse(progress?.lastAttempted || '');
            const lastAt = Number.isFinite(lastTimestamp) && lastTimestamp > 0 ? lastTimestamp : now.getTime();
            const dueAt = new Date(lastAt + intervalDays * 86_400_000);
            const daysUntilDue = Math.ceil((dueAt.getTime() - now.getTime()) / 86_400_000);
            topics.push({
                exam,
                subject,
                topic,
                accuracy,
                weightage: resolveTopicWeightage(exam, subject, topic, {}),
                intervalDays,
                dueAt: dueAt.toISOString().slice(0, 10),
                daysUntilDue,
                reason: accuracy < 70 ? 'Lower recent accuracy: revisit soon.' : 'Spaced review helps retain this topic.'
            });
        }
    }
    return topics.sort((left, right) => left.daysUntilDue - right.daysUntilDue
        || right.weightage - left.weightage || left.accuracy - right.accuracy);
}

export function getMockTestInsights(history = [], exam = 'SI') {
    const attempts = (Array.isArray(history) ? history : []).filter((attempt) => attempt?.exam === exam);
    const recent = attempts.slice(0, 20).reverse().map((attempt, index) => {
        const timeMatch = String(attempt.timeTaken || '').match(/^(\d+):(\d{2})$/);
        const elapsedSeconds = timeMatch ? Number(timeMatch[1]) * 60 + Number(timeMatch[2]) : 0;
        const questions = Array.isArray(attempt.questions) ? attempt.questions : [];
        const total = Number(attempt.total) || questions.length;
        const questionCounts = questions.reduce((counts, question) => {
            if (questionUnanswered(question)) {
                counts.unanswered += 1;
            } else if (questionCorrect(question)) {
                counts.correct += 1;
            } else {
                counts.incorrect += 1;
            }
            return counts;
        }, { correct: 0, incorrect: 0, unanswered: 0 });
        const correct = questions.length ? questionCounts.correct : Number(attempt.correct ?? attempt.score) || 0;
        const unanswered = questions.length ? questionCounts.unanswered : Number(attempt.unanswered) || 0;
        const incorrect = questions.length
            ? questionCounts.incorrect
            : Number(attempt.incorrect) || Math.max(0, total - correct - unanswered);
        const topicMetrics = new Map();
        for (const question of questions) {
            const subject = question.subject || attempt.subject || '';
            const topic = question.topic || attempt.topic || '';
            if (!topic) continue;
            const key = `${subject}\u0000${topic}`;
            const metric = topicMetrics.get(key) || { subject, topic, correct: 0, incorrect: 0, unanswered: 0, total: 0 };
            metric.total += 1;
            if (questionUnanswered(question)) {
                metric.unanswered += 1;
            } else if (questionCorrect(question)) {
                metric.correct += 1;
            } else {
                metric.incorrect += 1;
            }
            topicMetrics.set(key, metric);
        }
        const timestamp = String(attempt.submittedAt || '');
        const parsedTimestamp = Date.parse(timestamp);
        return {
            name: `Test ${index + 1}`,
            date: attempt.date || '',
            dateTime: Number.isFinite(parsedTimestamp)
                ? new Date(parsedTimestamp).toLocaleString()
                : attempt.date ? `${attempt.date} (time unavailable)` : 'Not recorded',
            accuracy: Number(attempt.accuracy) || 0,
            correct,
            incorrect,
            unanswered,
            total,
            averageSecondsPerQuestion: Number(attempt.averageSecondsPerQuestion)
                || (total ? Math.round(elapsedSeconds / total) : 0),
            subject: attempt.subject || '',
            topic: attempt.topic || [...topicMetrics.values()].map((metric) => metric.topic).join(', ') || 'Not recorded',
            topicMetrics: [...topicMetrics.values()].map((metric) => ({
                ...metric,
                accuracy: metric.total ? Math.round(metric.correct / metric.total * 100) : 0
            }))
        };
    });

    const byTopic = new Map();
    for (const attempt of attempts) {
        for (const question of Array.isArray(attempt.questions) ? attempt.questions : []) {
            const subject = question.subject || attempt.subject;
            const topic = question.topic || attempt.topic;
            if (!subject || !topic) continue;
            const key = `${subject}\u0000${topic}`;
            const metric = byTopic.get(key) || { subject, topic, correct: 0, total: 0 };
            metric.total += 1;
            if (questionCorrect(question)) metric.correct += 1;
            byTopic.set(key, metric);
        }
    }
    const topics = [...byTopic.values()]
        .map((item) => ({ ...item, accuracy: item.total ? Math.round(item.correct / item.total * 100) : 0 }))
        .sort((left, right) => right.accuracy - left.accuracy || right.total - left.total);
    return {
        recent,
        topics,
        strongest: topics[0] || null,
        needsWork: topics.length ? topics[topics.length - 1] : null
    };
}

function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

export function createProgressCsv({ profile, exam, history = [], progress = {}, recommendations = [] }) {
    const rows = [
        ['Report', 'TS Police AI Prep progress'],
        ['Candidate', profile?.name || ''],
        ['Email', profile?.email || ''],
        ['Exam', exam],
        [],
        ['Test history'],
        ['Date', 'Subject', 'Topic', 'Mode', 'Score', 'Total', 'Accuracy', 'Time taken', 'Average seconds per question']
    ];
    for (const attempt of history) {
        if (attempt?.exam !== exam) continue;
        rows.push([
            attempt.date || '', attempt.subject || '', attempt.topic || '', attempt.mode || 'topic',
            attempt.score ?? attempt.correct ?? 0, attempt.total ?? 0, `${attempt.accuracy ?? 0}%`,
            attempt.timeTaken || '', attempt.averageSecondsPerQuestion || ''
        ]);
    }
    rows.push([], ['Topic progress'], ['Subject', 'Topic', 'Accuracy', 'Attempts']);
    for (const item of Object.values(progress || {})) {
        if (item?.exam === exam) rows.push([item.subject, item.topic, `${item.accuracy ?? 0}%`, item.attempts ?? 0]);
    }
    rows.push([], ['Spaced revision'], ['Subject', 'Topic', 'Accuracy', 'Due date', 'Reason']);
    for (const item of recommendations) rows.push([item.subject, item.topic, `${item.accuracy}%`, item.dueAt, item.reason]);
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
