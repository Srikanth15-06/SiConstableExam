import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTestResult, normalizeAnswer } from './test-results.js';

const questions = Array.from({ length: 10 }, (_, index) => ({
    id: `q${index + 1}`,
    question: `Question ${index + 1}`,
    options: ['100', '25%', 'Delhi', '250'],
    correctAnswer: '100',
    explanation: 'The stored correct answer is 100.',
    shortcut: 'Check the calculation.'
}));

test('scores 7 correct, 2 incorrect, and 1 unanswered from question IDs', () => {
    const answers = Object.fromEntries(questions.slice(0, 9).map((question, index) => [question.id, index === 1 || index === 5 ? '250' : '100']));
    answers.notAQuestion = '100';
    const result = calculateTestResult(questions, answers);
    assert.deepEqual({ correct: result.correct, incorrect: result.incorrect, unanswered: result.unanswered, total: result.total, percentage: result.percentage, accuracy: result.accuracy }, {
        correct: 7, incorrect: 2, unanswered: 1, total: 10, percentage: 70, accuracy: 70
    });
    assert.equal(result.details[0].questionId, 'q1');
    assert.equal(result.details[1].userAnswer, '250');
    assert.equal(result.details[9].status, 'UNANSWERED');
});

test('scores all-correct, eight-correct, and unanswered-only attempts', () => {
    const allCorrect = calculateTestResult(questions, Object.fromEntries(questions.map((question) => [question.id, '100'])));
    const eightCorrect = calculateTestResult(questions, Object.fromEntries(questions.slice(0, 8).map((question) => [question.id, '100'])));
    const noneAnswered = calculateTestResult(questions, {});
    assert.deepEqual([allCorrect.correct, allCorrect.incorrect, allCorrect.unanswered, allCorrect.percentage], [10, 0, 0, 100]);
    assert.deepEqual([eightCorrect.correct, eightCorrect.incorrect, eightCorrect.unanswered, eightCorrect.percentage], [8, 0, 2, 80]);
    assert.deepEqual([noneAnswered.correct, noneAnswered.incorrect, noneAnswered.unanswered, noneAnswered.percentage], [0, 0, 10, 0]);
});

test('normalizes text formatting without conflating different numeric answers', () => {
    assert.equal(normalizeAnswer(' Delhi '), normalizeAnswer('delhi.'));
    assert.equal(normalizeAnswer('1,000'), normalizeAnswer('1000'));
    assert.equal(normalizeAnswer('1.00'), normalizeAnswer('1'));
    assert.notEqual(normalizeAnswer('25'), normalizeAnswer('250'));
    assert.notEqual(normalizeAnswer('25%'), normalizeAnswer('25'));
});