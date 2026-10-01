import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSubjectCompletion, calculateTopicPriority, buildPlannerSnapshot, daysRemainingForExam, getExamHistory, getLegacyTopicProgress, getProgressKey, getTopicProgress, getTopicStatus, mergePlannerSnapshot, normalizeUserProgress, resolveTopicWeightage } from './planner-utils.js';

const subjectTopics = {
    Arithmetic: ['Percentages', 'Average'],
    Reasoning: ['Coding-Decoding'],
    'General Studies': ['Indian Polity']
};

test('calculateTopicPriority weights accuracy, weightage, completion, and revision need together', () => {
    const critical = calculateTopicPriority({ accuracy: 32, completion: 20, weightage: 5, attempted: 0, recentAccuracy: 26, daysRemaining: 10, revisionRequired: true });
    const high = calculateTopicPriority({ accuracy: 52, completion: 40, weightage: 5, attempted: 2, recentAccuracy: 46, daysRemaining: 20, revisionRequired: true });
    const completed = calculateTopicPriority({ accuracy: 88, completion: 92, weightage: 2, attempted: 8, recentAccuracy: 90, daysRemaining: 30, revisionRequired: false });

    assert.equal(critical, 'CRITICAL');
    assert.equal(high, 'HIGH');
    assert.equal(completed, 'COMPLETED');
});

test('getTopicStatus distinguishes strong, weak, and critical topics from actual data', () => {
    assert.equal(getTopicStatus({ accuracy: 90, completion: 92, priority: 'LOW' }), 'Strong');
    assert.equal(getTopicStatus({ accuracy: 48, completion: 52, priority: 'HIGH' }), 'Weak');
    assert.equal(getTopicStatus({ accuracy: 30, completion: 20, priority: 'CRITICAL' }), 'Critical');
});

test('resolveTopicWeightage uses the selected exam role', () => {
    assert.equal(resolveTopicWeightage('SI', 'Arithmetic', 'Data Interpretation'), 5);
    assert.equal(resolveTopicWeightage('CONSTABLE', 'Arithmetic', 'Data Interpretation'), 4);
});

test('progress keys and lookups isolate the same topic by exam and subject', () => {
    const userProgress = {
        [getProgressKey('SI', 'Arithmetic', 'Percentages')]: { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 8 },
        [getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages')]: { exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 9 }
    };

    assert.notEqual(getProgressKey('SI', 'Arithmetic', 'Percentages'), getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages'));
    assert.equal(getTopicProgress(userProgress, 'SI', 'Arithmetic', 'Percentages').bestScore, 8);
    assert.equal(getTopicProgress(userProgress, 'CONSTABLE', 'Arithmetic', 'Percentages').bestScore, 9);
});

test('history selection returns only attempts for the selected exam', () => {
    const history = [{ id: 'si', exam: 'SI' }, { id: 'constable', exam: 'CONSTABLE' }, { id: 'unknown' }];
    assert.deepEqual(getExamHistory(history, 'SI').map((attempt) => attempt.id), ['si']);
    assert.deepEqual(getExamHistory(history, 'CONSTABLE').map((attempt) => attempt.id), ['constable']);
});

test('legacy progress with an exam moves to only that exam scoped key', () => {
    const normalized = normalizeUserProgress({
        Percentages: { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 8 }
    }, 'CONSTABLE', [], subjectTopics);

    assert.equal(normalized[getProgressKey('SI', 'Arithmetic', 'Percentages')].bestScore, 8);
    assert.equal(getTopicProgress(normalized, 'CONSTABLE', 'Arithmetic', 'Percentages'), null);
});

test('legacy progress without an exam is assigned only to the account exam and normalization is idempotent', () => {
    const legacy = {
        Percentages: { subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 8 }
    };
    const normalized = normalizeUserProgress(legacy, 'CONSTABLE', [], subjectTopics);
    const normalizedAgain = normalizeUserProgress(normalized, 'CONSTABLE', [], subjectTopics);

    assert.deepEqual(normalizedAgain, normalized);
    assert.equal(normalized[getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages')].bestScore, 8);
    assert.equal(normalized[getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages')].roleInferred, true);
    assert.equal(getTopicProgress(normalized, 'SI', 'Arithmetic', 'Percentages'), null);
    assert.equal(Object.keys(normalized).length, 1);
});

test('legacy topic progress without a uniquely inferable subject is not shown under an arbitrary subject', () => {
    const legacy = { 'Number Series': { attempts: 1, bestScore: 8 } };
    assert.equal(getLegacyTopicProgress(legacy, 'SI', 'SI', 'Arithmetic', 'Number Series'), null);
    assert.equal(getLegacyTopicProgress(legacy, 'SI', 'SI', 'Reasoning', 'Number Series'), null);
});

test('role-tagged history rebuilds separate progress instead of carrying a mixed legacy summary', () => {
    const history = [
        { exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner', score: 9, correct: 9, total: 10, accuracy: 90, status: 'LEVEL PASSED', date: '2026-09-02' },
        { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner', score: 8, correct: 8, total: 10, accuracy: 80, status: 'LEVEL PASSED', date: '2026-09-01' }
    ];
    const normalized = normalizeUserProgress({
        Percentages: { exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', attempts: 2, bestScore: 9, correctAnswers: 17, totalQuestions: 20, accuracy: 85 }
    }, 'CONSTABLE', history, subjectTopics);

    assert.deepEqual(normalized[getProgressKey('SI', 'Arithmetic', 'Percentages')], {
        exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', level: 'Intermediate', bestScore: 8,
        attempts: 1, correctAnswers: 8, totalQuestions: 10, accuracy: 80
    });
    assert.deepEqual(normalized[getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages')], {
        exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', level: 'Intermediate', bestScore: 9,
        attempts: 1, correctAnswers: 9, totalQuestions: 10, accuracy: 90
    });
});

test('dashboard subject completion uses only selected-role progress and history', () => {
    const progress = {
        [getProgressKey('SI', 'Arithmetic', 'Percentages')]: { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 8 },
        [getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages')]: { exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 9 }
    };
    const history = [
        { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages' },
        { exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages' }
    ];

    assert.equal(calculateSubjectCompletion('Arithmetic', subjectTopics.Arithmetic, progress, history, 'SI'), 48);
    assert.equal(calculateSubjectCompletion('Arithmetic', subjectTopics.Arithmetic, progress, history, 'CONSTABLE'), 49);
});

test('planner completion is isolated by candidate and exam role', () => {
    const highProgress = buildPlannerSnapshot({
        id: 'candidate-a',
        userProgress: { Percentages: { exam: 'SI', attempts: 8 } },
        testHistory: []
    }, 'SI', subjectTopics);
    const lowProgress = buildPlannerSnapshot({
        id: 'candidate-b',
        userProgress: { Percentages: { exam: 'SI', attempts: 1 } },
        testHistory: []
    }, 'SI', subjectTopics);
    const switchedRole = buildPlannerSnapshot({
        id: 'candidate-a',
        userProgress: { Percentages: { exam: 'SI', attempts: 8 } },
        testHistory: [{ exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', accuracy: 20, total: 10 }]
    }, 'CONSTABLE', subjectTopics);

    assert.notEqual(
        highProgress.topicMetrics.find((metric) => metric.topic === 'Percentages').completion,
        lowProgress.topicMetrics.find((metric) => metric.topic === 'Percentages').completion
    );
    assert.equal(switchedRole.topicMetrics.find((metric) => metric.topic === 'Percentages').completion, 30);
});

test('progress from another exam alone does not activate the selected-role planner', () => {
    const snapshot = buildPlannerSnapshot({
        id: 'candidate-role-empty',
        exam: 'CONSTABLE',
        userProgress: {
            [getProgressKey('SI', 'Arithmetic', 'Percentages')]: {
                exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 8
            }
        },
        testHistory: []
    }, 'CONSTABLE', subjectTopics);

    assert.equal(snapshot.summary.testsAttempted, 0);
    assert.deepEqual(snapshot.schedule, []);
    assert.equal(snapshot.topicMetrics.find((metric) => metric.topic === 'Percentages').completion, 0);
});

test('planner merge refreshes selected-role metrics and preserves schedules for both roles', () => {
    const member = {
        id: 'planner-role-candidate',
        exam: 'CONSTABLE',
        userProgress: {
            [getProgressKey('SI', 'Arithmetic', 'Percentages')]: { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 8 },
            [getProgressKey('CONSTABLE', 'Arithmetic', 'Percentages')]: { exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', attempts: 1, bestScore: 9 }
        },
        testHistory: [
            { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', correct: 8, score: 8, accuracy: 80, total: 10, date: '2026-09-01' },
            { exam: 'CONSTABLE', subject: 'Arithmetic', topic: 'Percentages', correct: 9, score: 9, accuracy: 90, total: 10, date: '2026-09-02' }
        ]
    };
    const savedSi = buildPlannerSnapshot(member, 'SI', subjectTopics);
    const manualSiTask = {
        id: 'manual-si', examType: 'SI', date: '2026-10-02', startTime: '18:00', autoGenerated: false
    };
    const savedWithManualTask = { ...savedSi, schedule: [...savedSi.schedule, manualSiTask] };

    const constableView = mergePlannerSnapshot(savedWithManualTask, member, 'CONSTABLE', subjectTopics);
    assert.equal(constableView.examType, 'CONSTABLE');
    assert.equal(constableView.summary.testsAttempted, 1);
    const constableMetric = constableView.topicMetrics.find((metric) => metric.topic === 'Percentages');
    assert.equal(constableMetric.accuracy, 90);
    assert.equal(constableMetric.lastAttempted, '2026-09-02');
    assert.ok(constableView.schedule.some((task) => task.id === manualSiTask.id));
    assert.ok(constableView.schedule.some((task) => task.examType === 'SI' && task.autoGenerated));
    assert.ok(constableView.schedule.some((task) => task.examType === 'CONSTABLE' && task.autoGenerated));

    const siView = mergePlannerSnapshot(constableView, member, 'SI', subjectTopics);
    assert.equal(siView.examType, 'SI');
    assert.equal(siView.summary.testsAttempted, 1);
    const siMetric = siView.topicMetrics.find((metric) => metric.topic === 'Percentages');
    assert.equal(siMetric.accuracy, 80);
    assert.equal(siMetric.lastAttempted, '2026-09-01');
    assert.notEqual(constableMetric.recommendedMinutes, siMetric.recommendedMinutes);
    assert.ok(siView.schedule.some((task) => task.id === manualSiTask.id));
});

test('buildPlannerSnapshot keeps candidate data isolated and creates a future auto-generated schedule', () => {
    const member = {
        id: 'member-1',
        exam: 'SI',
        userProgress: {
            Percentages: { attempts: 2 },
            Average: { attempts: 1 }
        },
        testHistory: [
            { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', correct: 4, incorrect: 3, unanswered: 3, accuracy: 40, total: 10, date: '2026-09-01' },
            { exam: 'SI', subject: 'Arithmetic', topic: 'Average', correct: 8, incorrect: 1, unanswered: 1, accuracy: 80, total: 10, date: '2026-09-02' }
        ]
    };

    const snapshot = buildPlannerSnapshot(member, 'SI', subjectTopics);
    assert.equal(snapshot.examType, 'SI');
    assert.ok(snapshot.schedule.length >= 3);
    assert.ok(snapshot.schedule.every((task) => task.userId === 'member-1'));
    assert.ok(snapshot.schedule.every((task) => task.examType === 'SI'));
    assert.ok(snapshot.topicMetrics.some((metric) => metric.topic === 'Percentages'));
    assert.ok(snapshot.topicMetrics.some((metric) => metric.topic === 'Average'));
});

test('buildPlannerSnapshot keeps topic weightage visible without creating a default schedule when there is no study data', () => {
    const member = {
        id: 'member-empty',
        exam: 'SI',
        userProgress: {},
        testHistory: []
    };

    const snapshot = buildPlannerSnapshot(member, 'SI', subjectTopics);
    assert.equal(snapshot.examType, 'SI');
    assert.deepEqual(snapshot.schedule, []);
    assert.ok(snapshot.topicMetrics.length > 0);
    assert.ok(snapshot.topicMetrics.some((metric) => metric.topic === 'Percentages' && metric.weightage === 5));
    assert.ok(snapshot.topicMetrics.some((metric) => metric.topic === 'Average' && metric.weightage === 3));
    assert.deepEqual(snapshot.summary, {
        overallProgress: 0,
        syllabusCompletion: 0,
        testsAttempted: 0,
        averageAccuracy: 0,
        strongTopics: 0,
        weakTopics: 0,
        criticalTopics: 0,
        studyStreak: 1,
        daysRemaining: daysRemainingForExam('SI'),
        todaysTasks: 0,
        upcomingTasks: 0
    });
});
