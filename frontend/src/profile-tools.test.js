import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressCsv, getMistakeNotebook, getMockTestInsights, getSpacedRevisionRecommendations } from './profile-tools.js';
import { getProgressKey } from './planner-utils.js';

const subjectTopics = { Arithmetic: ['Percentages', 'Profit and Loss'] };

test('mistake notebook scopes to selected exam and includes incorrect and unanswered questions', () => {
    const history = [
        {
            exam: 'SI', attemptId: 'attempt-1', date: '2026-10-03', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner',
            questions: [
                { id: 'q1', question: 'Wrong answer', status: 'INCORRECT', userAnswer: '5', correctAnswer: '4' },
                { id: 'q2', question: 'Skipped', status: 'UNANSWERED', userAnswer: '', correctAnswer: 'B' },
                { id: 'q3', question: 'Correct', status: 'CORRECT', userAnswer: 'A', correctAnswer: 'A' }
            ]
        },
        { exam: 'CONSTABLE', date: '2026-10-04', questions: [{ id: 'q4', status: 'INCORRECT' }] }
    ];
    const notebook = getMistakeNotebook(history, 'SI');
    assert.deepEqual(notebook.map((item) => item.id), ['q1', 'q2']);
    assert.deepEqual(notebook.map((item) => item.answerStatus), ['Incorrect', 'Unanswered']);
    assert.equal(notebook[0].topic, 'Percentages');
});

test('spaced revision intervals adapt to the latest per-topic accuracy and due date', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const progress = {
        [getProgressKey('SI', 'Arithmetic', 'Percentages')]: { exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', attempts: 1 }
    };
    const history = [{
        exam: 'SI', submittedAt: '2026-10-01T00:00:00Z', subject: 'Arithmetic', topic: 'Percentages',
        questions: Array.from({ length: 10 }, (_, index) => ({
            id: `q${index}`, subject: 'Arithmetic', topic: 'Percentages',
            status: index < 4 ? 'CORRECT' : 'INCORRECT'
        }))
    }];
    const recommendations = getSpacedRevisionRecommendations(progress, history, 'SI', subjectTopics, now);
    assert.equal(recommendations.length, 1);
    assert.equal(recommendations[0].accuracy, 40);
    assert.equal(recommendations[0].intervalDays, 1);
    assert.equal(recommendations[0].dueAt, '2026-10-02');
    assert.equal(recommendations[0].daysUntilDue, -8);
});

test('mock insights summarize accuracy trend, average time, and strongest/weakest topics', () => {
    const insights = getMockTestInsights([
        {
            exam: 'SI', date: '2026-10-03', accuracy: 70, timeTaken: '10:00', total: 10,
            questions: [
                { subject: 'Arithmetic', topic: 'Percentages', status: 'CORRECT' },
                { subject: 'Reasoning', topic: 'Analogy', status: 'INCORRECT' }
            ]
        }
    ]);
    assert.equal(insights.recent[0].averageSecondsPerQuestion, 60);
    assert.equal(insights.strongest.topic, 'Percentages');
    assert.equal(insights.needsWork.topic, 'Analogy');
});

test('progress CSV quotes cells and neutralizes spreadsheet formulas', () => {
    const csv = createProgressCsv({
        profile: { name: '=HYPERLINK("bad")', email: 'candidate@example.test' },
        exam: 'SI',
        history: [{ exam: 'SI', subject: 'Arithmetic', topic: 'Percentages', accuracy: 80, total: 10, score: 8 }],
        progress: {},
        recommendations: []
    });
    assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
    assert.match(csv, /"Percentages"/);
});
