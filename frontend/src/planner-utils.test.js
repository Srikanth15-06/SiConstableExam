import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTopicPriority, buildPlannerSnapshot, getTopicStatus } from './planner-utils.js';

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
