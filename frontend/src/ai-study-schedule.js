const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const SUBJECT_CODES = {
  Arithmetic: 'A',
  Reasoning: 'R',
  'General Studies': 'G',
  'Telangana GK': 'T',
  English: 'E'
};

export function buildAiSchedulePrompt(topicMetrics, { examType, dailyMinutes, daysRemaining }) {
  const rows = topicMetrics.map((metric, id) => [
    SUBJECT_CODES[metric.subject] || 'X',
    id,
    metric.topic,
    `w${metric.weightage}`,
    `a${metric.accuracy}`,
    `c${metric.completion}`,
    `r${metric.recentAccuracy}`,
    `n${metric.attempted}`
  ].join('|'));
  const input = [
    `Exam: TS ${examType === 'CONSTABLE' ? 'Constable' : 'SI'}. Days to exam: ${daysRemaining}. Available study time: ${dailyMinutes} minutes/day.`,
    'Subject codes: A=Arithmetic, R=Reasoning, G=General Studies, T=Telangana GK, E=English.',
    'Rank every numeric topic ID exactly once. Prioritize exam weightage, low completion, low/recent accuracy, and unattempted topics. Balance coverage across subjects and use the time remaining realistically.',
    'Return only JSON: {"priorityTopicIds":[numeric IDs in priority order],"strategy":"brief personalized strategy"}. Do not invent topics or omit IDs.',
    ...rows
  ].join('\n');

  if (input.length > 7900) {
    const compactRows = topicMetrics.map((metric, id) => [
      SUBJECT_CODES[metric.subject] || 'X',
      id,
      metric.topic,
      metric.weightage,
      metric.accuracy,
      metric.completion
    ].join('|'));
    const compactInput = [
      `Exam: TS ${examType === 'CONSTABLE' ? 'Constable' : 'SI'}. Days to exam: ${daysRemaining}. Available study time: ${dailyMinutes} minutes/day.`,
      'Subject codes: A=Arithmetic, R=Reasoning, G=General Studies, T=Telangana GK, E=English.',
      'Rank every numeric topic ID exactly once. Prioritize high weightage, low accuracy and low completion. Return only JSON: {"priorityTopicIds":[numeric IDs in priority order],"strategy":"brief personalized strategy"}.',
      ...compactRows
    ].join('\n');
    if (compactInput.length > 7900) throw new Error('The syllabus is too large to create an AI schedule.');
    return compactInput;
  }
  return input;
}

export function parseAiScheduleResponse(reply, topicCount) {
  const text = String(reply || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI returned an invalid study schedule. Please regenerate it.');

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('The AI returned an invalid study schedule. Please regenerate it.');
  }
  const rawIds = parsed.priorityTopicIds || parsed.topicOrder || parsed.order;
  if (!Array.isArray(rawIds)) throw new Error('The AI schedule did not include a topic priority list. Please regenerate it.');

  const seen = new Set();
  const priorityTopicIds = rawIds
    .map((id) => typeof id === 'number' ? id : (typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : Number.NaN))
    .filter((id) => Number.isInteger(id) && id >= 0 && id < topicCount && !seen.has(id) && seen.add(id));
  if (!priorityTopicIds.length) throw new Error('The AI schedule did not identify any syllabus topics. Please regenerate it.');

  return {
    priorityTopicIds,
    strategy: typeof parsed.strategy === 'string' ? parsed.strategy.trim().slice(0, 600) : ''
  };
}

function fallbackScore(metric) {
  return (Number(metric.weightage) || 1) * 12
    + Math.max(0, 100 - (Number(metric.completion) || 0)) * 0.35
    + Math.max(0, 100 - (Number(metric.accuracy) || 0)) * 0.25
    + Math.max(0, 100 - (Number(metric.recentAccuracy) || 0)) * 0.15
    + (Number(metric.attempted) === 0 ? 25 : 0);
}

function addDays(date, offset) {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

export function buildAiStudySchedule(topicMetrics, priorityTopicIds, {
  examType = 'SI',
  dailyMinutes = 180,
  daysRemaining = 0,
  today = new Date()
} = {}) {
  const normalizedDays = clamp(Math.floor(Number(daysRemaining) || 0), 0, 400);
  const normalizedDailyMinutes = clamp(Math.round(Number(dailyMinutes) || 180), 30, 720);
  const metrics = Array.isArray(topicMetrics) ? topicMetrics : [];
  const fallbackIds = metrics
    .map((metric, id) => ({ metric, id }))
    .sort((left, right) => fallbackScore(right.metric) - fallbackScore(left.metric))
    .map(({ id }) => id);
  const aiIds = Array.isArray(priorityTopicIds) ? priorityTopicIds : [];
  const orderedIds = [...new Set([
    ...aiIds.filter((id) => Number.isInteger(id) && id >= 0 && id < metrics.length),
    ...fallbackIds
  ])];
  const days = normalizedDays > 0 ? normalizedDays : 0;
  if (!days || !metrics.length) {
    return {
      sessions: [],
      totalTopics: metrics.length,
      coverageCount: 0,
      daysRemaining: days,
      dailyMinutes: normalizedDailyMinutes,
      recommendedDailyMinutes: 0,
      minimumDaysRequired: Math.ceil((metrics.length * 10) / normalizedDailyMinutes),
      cannotCoverAll: metrics.length > 0,
      compressed: false
    };
  }

  const availableMinutes = days * normalizedDailyMinutes;
  const minimumSessionMinutes = 10;
  const recommendedTotal = orderedIds.reduce((sum, id) => {
    const metric = metrics[id];
    const recommended = Number(metric.recommendedMinutes)
      || (25 + (Number(metric.weightage) || 1) * 5 + Math.max(0, 65 - (Number(metric.accuracy) || 0)) * 0.25);
    return sum + clamp(Math.round(recommended), minimumSessionMinutes, 90);
  }, 0);
  const maxSchedulableTopics = Math.min(metrics.length, Math.floor(availableMinutes / minimumSessionMinutes));
  const requested = orderedIds.slice(0, maxSchedulableTopics).map((id) => {
    const metric = metrics[id];
    const recommended = Number(metric.recommendedMinutes)
      || (25 + (Number(metric.weightage) || 1) * 5 + Math.max(0, 65 - (Number(metric.accuracy) || 0)) * 0.25);
    return {
      id,
      metric,
      minutes: clamp(Math.round(recommended), minimumSessionMinutes, Math.min(90, normalizedDailyMinutes))
    };
  });
  const requestedTotal = requested.reduce((sum, task) => sum + task.minutes, 0);
  const compressed = requested.length < metrics.length || requestedTotal > availableMinutes;
  const minimumMinutes = requested.length ? minimumSessionMinutes : 0;
  let plannedTotal = 0;
  const topicsPerDay = requested.length ? Math.ceil(requested.length / days) : 0;
  const maxSessionMinutes = topicsPerDay
    ? Math.max(minimumSessionMinutes, Math.floor(normalizedDailyMinutes / topicsPerDay))
    : normalizedDailyMinutes;
  requested.forEach((task) => {
    if (compressed) task.minutes = Math.max(minimumMinutes, Math.floor(task.minutes * availableMinutes / requestedTotal));
    task.minutes = Math.min(task.minutes, maxSessionMinutes);
    plannedTotal += task.minutes;
  });
  for (let index = requested.length - 1; plannedTotal > availableMinutes && index >= 0; index -= 1) {
    const reducible = requested[index].minutes - minimumMinutes;
    const reduction = Math.min(reducible, plannedTotal - availableMinutes);
    requested[index].minutes -= reduction;
    plannedTotal -= reduction;
  }

  const dailyLoads = Array(days).fill(0);
  const sessions = requested.map((task, rank) => {
    let dayIndex = dailyLoads.findIndex((load) => load + task.minutes <= normalizedDailyMinutes);
    if (dayIndex < 0) {
      dayIndex = dailyLoads.indexOf(Math.min(...dailyLoads));
    }
    dailyLoads[dayIndex] += task.minutes;
    return {
      id: `ai-${examType}-${task.metric.subject}-${task.metric.topic}-${rank}`,
      examType,
      date: addDays(today, dayIndex),
      subject: task.metric.subject,
      topic: task.metric.topic,
      duration: task.minutes,
      weightage: Number(task.metric.weightage) || 1,
      accuracy: Number(task.metric.accuracy) || 0,
      completion: Number(task.metric.completion) || 0,
      priority: task.metric.priority || 'MEDIUM',
      reason: `${task.metric.weightage || 1} weightage; ${task.metric.completion || 0}% completion; ${task.metric.accuracy || 0}% accuracy.`,
      rank: rank + 1
    };
  });

  return {
    sessions,
    totalTopics: metrics.length,
    coverageCount: sessions.length,
    daysRemaining: days,
    dailyMinutes: normalizedDailyMinutes,
    recommendedDailyMinutes: Math.ceil(recommendedTotal / days),
    minimumDaysRequired: Math.ceil((metrics.length * minimumSessionMinutes) / normalizedDailyMinutes),
    cannotCoverAll: requested.length < metrics.length,
    compressed,
    plannedMinutes: plannedTotal
  };
}
