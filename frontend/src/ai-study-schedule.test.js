import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiSchedulePrompt, buildAiStudySchedule, parseAiScheduleResponse } from './ai-study-schedule.js';
import { SUBJECT_TOPICS } from './syllabus.js';
import { buildPlannerSnapshot } from './planner-utils.js';

const metrics = [
  { subject: 'Arithmetic', topic: 'Percentages', weightage: 5, accuracy: 30, completion: 20, recentAccuracy: 25, attempted: 1, recommendedMinutes: 60, priority: 'CRITICAL' },
  { subject: 'English', topic: 'Tenses', weightage: 3, accuracy: 75, completion: 80, recentAccuracy: 70, attempted: 4, recommendedMinutes: 30, priority: 'MEDIUM' },
  { subject: 'Reasoning', topic: 'Analogy', weightage: 4, accuracy: 0, completion: 0, recentAccuracy: 0, attempted: 0, recommendedMinutes: 45, priority: 'HIGH' }
];

test('AI schedule prompt includes role, available time, and every topic with its progress signals', () => {
  const prompt = buildAiSchedulePrompt(metrics, { examType: 'CONSTABLE', dailyMinutes: 120, daysRemaining: 20 });
  assert.match(prompt, /TS Constable/);
  assert.match(prompt, /120 minutes\/day/);
  assert.match(prompt, /Percentages/);
  assert.match(prompt, /Tenses/);
  assert.match(prompt, /Analogy/);
  assert.match(prompt, /w5\|a30\|c20/);
});

test('AI schedule response parsing validates and deduplicates topic IDs', () => {
  assert.deepEqual(parseAiScheduleResponse('Plan: {"priorityTopicIds":[2,"0",2,99],"strategy":"Focus on weak high-weight topics."}', 3), {
    priorityTopicIds: [2, 0],
    strategy: 'Focus on weak high-weight topics.'
  });
  assert.throws(() => parseAiScheduleResponse('not JSON', 3), /invalid study schedule/i);
  assert.throws(() => parseAiScheduleResponse('{"priorityTopicIds":[99]}', 3), /did not identify/i);
});

test('schedule covers every topic, follows AI ranking, and fits the daily time budget when feasible', () => {
  const schedule = buildAiStudySchedule(metrics, [2, 0], {
    examType: 'SI',
    dailyMinutes: 60,
    daysRemaining: 4,
    today: new Date(2026, 9, 3)
  });

  assert.equal(schedule.coverageCount, metrics.length);
  assert.equal(schedule.sessions[0].topic, 'Analogy');
  assert.equal(schedule.sessions[1].topic, 'Percentages');
  assert.equal(schedule.compressed, false);
  const loadsByDate = schedule.sessions.reduce((loads, session) => {
    loads[session.date] = (loads[session.date] || 0) + session.duration;
    return loads;
  }, {});
  assert.ok(Object.values(loadsByDate).every((minutes) => minutes <= 60));
});

test('schedule compresses topics to fit short preparation windows and reports compression', () => {
  const schedule = buildAiStudySchedule(metrics, [0, 1, 2], {
    dailyMinutes: 30,
    daysRemaining: 1,
    today: new Date(2026, 9, 3)
  });
  assert.equal(schedule.coverageCount, metrics.length);
  assert.equal(schedule.compressed, true);
  assert.ok(schedule.plannedMinutes <= 30);
  assert.ok(schedule.sessions.every((session) => session.duration > 0));
});

test('schedule returns no sessions after the exam date', () => {
  const schedule = buildAiStudySchedule(metrics, [], { dailyMinutes: 180, daysRemaining: 0 });
  assert.equal(schedule.coverageCount, 0);
  assert.equal(schedule.totalTopics, metrics.length);
});

test('full syllabus schedule assigns all 129 configured topics', () => {
  const topicMetrics = buildPlannerSnapshot({ exam: 'SI', testHistory: [], userProgress: {} }, 'SI', SUBJECT_TOPICS).topicMetrics;
  const schedule = buildAiStudySchedule(topicMetrics, [], {
    dailyMinutes: 180,
    daysRemaining: 57,
    today: new Date(2026, 9, 3)
  });
  const expectedTopicCount = Object.values(SUBJECT_TOPICS).reduce((count, topics) => count + topics.length, 0);

  assert.equal(expectedTopicCount, 129);
  assert.equal(schedule.coverageCount, expectedTopicCount);
  assert.equal(new Set(schedule.sessions.map(({ subject, topic }) => `${subject}|${topic}`)).size, expectedTopicCount);
  const dailyLoads = schedule.sessions.reduce((loads, session) => {
    loads[session.date] = (loads[session.date] || 0) + session.duration;
    return loads;
  }, {});
  assert.ok(Object.values(dailyLoads).every((minutes) => minutes <= 180));
});

test('schedule preserves daily time limit and reports when the exam window cannot fit every topic', () => {
  const topicMetrics = buildPlannerSnapshot({ exam: 'SI', testHistory: [], userProgress: {} }, 'SI', SUBJECT_TOPICS).topicMetrics;
  const schedule = buildAiStudySchedule(topicMetrics, [], {
    dailyMinutes: 30,
    daysRemaining: 1,
    today: new Date(2026, 9, 3)
  });

  assert.equal(schedule.coverageCount, 3);
  assert.equal(schedule.cannotCoverAll, true);
  assert.equal(schedule.minimumDaysRequired, 43);
  assert.equal(schedule.plannedMinutes, 30);
  assert.ok(schedule.sessions.every((session) => session.duration === 10));
});
