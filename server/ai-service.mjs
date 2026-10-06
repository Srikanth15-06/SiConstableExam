import { getProviderConfig, sanitizeApiError } from './provider-manager.mjs';
import { randomUUID } from 'node:crypto';
import { validateGoogleDriveConfig } from './google-drive-service.mjs';

const providerKeyCooldowns = new Map();
const lastSuccessfulProviderSelections = new Map();
const KEY_COOLDOWN_MS = 60_000;
const MAX_QUESTION_BATCHES = 4;
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const PROVIDER_POOL_TIMEOUT_MS = 60_000;
const MAX_PROVIDER_ATTEMPTS = 12;

export class AIProviderError extends Error {
    constructor(provider, code, message, diagnostics = {}) {
        super(message);
        this.name = 'AIProviderError';
        this.provider = provider;
        this.code = code;
        this.diagnostics = diagnostics;
    }
}

function parseJsonLike(text) {
    if (!text) return null;
    const trimmed = text.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const jsonText = trimmed.slice(start, end + 1);
        try {
            return JSON.parse(jsonText);
        } catch {
            return null;
        }
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function requestContext(payload) {
    const context = {
        exam: String(payload?.exam || '').trim(),
        subject: String(payload?.subject || '').trim(),
        topic: String(payload?.topic || '').trim(),
        difficulty: String(payload?.difficulty || payload?.level || '').trim()
    };
    if (Object.values(context).some((value) => !value)) {
        throw new AIProviderError('ai', 'INVALID_REQUEST', 'Exam, subject, topic, and difficulty are required.');
    }
    return context;
}

function formatChatSyllabus(syllabus) {
    if (!syllabus || typeof syllabus !== 'object' || Array.isArray(syllabus)) return '';
    const supportedSubjects = new Set(['Arithmetic', 'Reasoning', 'General Studies', 'Telangana GK', 'English']);
    return Object.entries(syllabus)
        .filter(([subject, topics]) => supportedSubjects.has(subject) && Array.isArray(topics))
        .map(([subject, topics]) => {
            const topicList = topics
                .filter((topic) => typeof topic === 'string' && topic.trim())
                .slice(0, 40)
                .map((topic) => topic.trim().replace(/[\r\n]/g, ' ').slice(0, 120));
            return topicList.length ? `${subject}: ${topicList.join('; ')}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

function providerFailure(provider, failures) {
    const latest = failures.at(-1) || {};
    const code = latest.httpStatus === 429 ? 'RATE_LIMITED'
        : latest.httpStatus === 401 || latest.httpStatus === 403 ? 'INVALID_KEY'
            : latest.httpStatus === 404 ? 'MODEL_UNAVAILABLE'
                : latest.code || 'ALL_ATTEMPTS_FAILED';
    const message = latest.reason || `${provider} could not complete the request.`;
    return new AIProviderError(provider, code, message, {
        model: latest.model,
        keyIndex: latest.keyIndex,
        httpStatus: latest.httpStatus,
        reason: message,
        attempts: failures.slice(-6)
    });
}

async function requestProviderPool(provider, config, sendRequest, parseResponse, operationDeadline = Date.now() + PROVIDER_POOL_TIMEOUT_MS) {
    if (!config.apiKeyEntries?.length || !config.models.length) {
        throw new AIProviderError(provider, 'NOT_CONFIGURED', `${provider} has no configured API keys or models.`);
    }

    const failures = [];
    const deadline = Math.min(Date.now() + PROVIDER_POOL_TIMEOUT_MS, operationDeadline);
    let attemptCount = 0;
    for (const { index: keyIndex, key } of config.apiKeyEntries) {
        if (attemptCount >= MAX_PROVIDER_ATTEMPTS || Date.now() >= deadline) break;
        const cooldownKey = `${provider}:${keyIndex}`;
        if ((providerKeyCooldowns.get(cooldownKey) || 0) > Date.now()) continue;

        for (const model of config.models) {
            if (attemptCount >= MAX_PROVIDER_ATTEMPTS || Date.now() >= deadline) break;
            attemptCount += 1;
            try {
                const timeoutMs = Math.max(1, Math.min(PROVIDER_REQUEST_TIMEOUT_MS, deadline - Date.now()));
                const response = await sendRequest(key, model, AbortSignal.timeout(timeoutMs));
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    const reason = sanitizeApiError(data?.error?.message || response.statusText || 'Provider request failed.');
                    failures.push({ model, keyIndex, httpStatus: response.status, reason });
                    if (response.status === 429) {
                        providerKeyCooldowns.set(cooldownKey, Date.now() + KEY_COOLDOWN_MS);
                        break;
                    }
                    if (response.status === 401 || response.status === 403) break;
                    continue;
                }

                const value = parseResponse(data);
                if (value !== null && value !== undefined) {
                    const providerKey = provider.toLowerCase();
                    lastSuccessfulProviderSelections.set(providerKey, { activeModel: model, activeKeyNumber: keyIndex });
                    return { value, model, keyIndex };
                }
                failures.push({ model, keyIndex, code: 'INVALID_PROVIDER_RESPONSE', reason: 'Provider returned an invalid response.' });
            } catch (error) {
                failures.push({ model, keyIndex, code: 'NETWORK_ERROR', reason: sanitizeApiError(error) });
            }
        }
    }

    throw providerFailure(provider, failures);
}

function normalizeText(value) {
    return String(value || '').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function questionSignature(question) {
    return normalizeText(question?.question);
}

function normalizeQuestionAnswer(question) {
    if (!question || !Array.isArray(question.options)) return null;
    const options = question.options.map((option) => String(option).trim());
    const suppliedAnswer = String(question.correctAnswer || '').trim();
    const exactOption = options.find((option) => normalizeText(option) === normalizeText(suppliedAnswer));
    if (exactOption) return { ...question, options, correctAnswer: exactOption };
    const answerLabel = suppliedAnswer.match(/^(?:option\s*)?([A-D])(?:[).:]\s*.*)?$/i);
    if (!answerLabel) return null;
    const optionIndex = answerLabel[1].toUpperCase().charCodeAt(0) - 65;
    return options[optionIndex] ? { ...question, options, correctAnswer: options[optionIndex] } : null;
}

function isQuestionValid(question, request) {
    if (!question || typeof question !== 'object') return false;
    const text = String(question.question || '').trim();
    const explanation = String(question.explanation || '').trim();
    const shortcut = String(question.shortcut || '').trim();
    const correctAnswer = String(question.correctAnswer || '').trim();
    const options = Array.isArray(question.options) ? question.options.map((option) => String(option).trim()) : [];
    const placeholderPattern = /\b(?:lorem ipsum|placeholder|sample question|insert question|question text here|option [a-d])\b/i;
    if (!text || !explanation || !shortcut || !correctAnswer || placeholderPattern.test(`${text} ${options.join(' ')} ${explanation} ${shortcut}`)) return false;
    if (options.length !== 4 || options.some((option) => !option)) return false;
    if (new Set(options.map(normalizeText)).size !== 4) return false;
    if (!options.some((option) => normalizeText(option) === normalizeText(correctAnswer))) return false;
    if (normalizeText(question.subject) !== normalizeText(request.subject)) return false;
    if (normalizeText(question.topic) !== normalizeText(request.topic)) return false;
    if (normalizeText(question.difficulty || question.level) !== normalizeText(request.difficulty)) return false;

    const percentOfMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of)\s*(\d+(?:\.\d+)?)/i);
    if (percentOfMatch) {
        const expected = Number(percentOfMatch[1]) * Number(percentOfMatch[2]) / 100;
        const answerNumber = Number(correctAnswer.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
        if (!Number.isFinite(answerNumber) || Math.abs(expected - answerNumber) > 0.000001) return false;
    }
    return true;
}

function questionGenerationPrompt(payload) {
    return `
You are a strict exam question generator. Generate exactly ${payload.count} questions and return only JSON.
The complete required context is:
Exam: ${payload.exam}
Subject: ${payload.subject}
Topic: ${payload.topic}
Difficulty: ${payload.difficulty}
Generate ONLY questions belonging to that exact exam, subject, topic, and difficulty. Do not use questions from another subject or topic.
Every item must have question, options (exactly four distinct strings), correctAnswer (exactly one option), explanation, shortcut, subject, topic, difficulty.
Set subject, topic, and difficulty metadata to the exact requested values above. Include no placeholders, repeated questions, markdown, or text outside the JSON object {"questions":[]}.
Attempt seed: ${payload.attemptSeed}.
Do not repeat these questions: ${JSON.stringify(payload.previousQuestionSignatures)}
`;
}

async function callGeminiQuestionGeneration(payload, operationDeadline) {
    const config = getProviderConfig('gemini');
    const prompt = questionGenerationPrompt(payload);

    const result = await requestProviderPool('Gemini', config, (key, model, signal) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
        })
    }), (data) => {
        const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') || '';
        const json = parseJsonLike(text);
        return json && Array.isArray(json.questions) ? json.questions : null;
    }, operationDeadline);
    return { questions: result.value, model: result.model, keyIndex: result.keyIndex };
}

async function callOpenAIQuestionGeneration(providerName, payload, operationDeadline) {
    const config = getProviderConfig(providerName);
    const displayName = providerName === 'groq' ? 'Groq' : 'OpenRouter';
    const endpoint = providerName === 'groq'
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
    const prompt = questionGenerationPrompt(payload);
    const result = await requestProviderPool(displayName, config, (key, model, signal) => fetch(endpoint, {
        method: 'POST',
        signal,
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            ...(providerName === 'openrouter' ? {
                'HTTP-Referer': process.env.OPENROUTER_SITE_URL || process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5173',
                'X-Title': 'TS Police AI Prep'
            } : {})
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' }
        })
    }), (data) => {
        const json = parseJsonLike(data?.choices?.[0]?.message?.content || '');
        return json && Array.isArray(json.questions) ? json.questions : null;
    }, operationDeadline);
    return { questions: result.value, model: result.model, keyIndex: result.keyIndex };
}

async function callQuestionGenerationProvider(payload, operationDeadline) {
    const failures = [];
    for (const [provider, call] of [
        ['Gemini', (request) => callGeminiQuestionGeneration(request, operationDeadline)],
        ['Groq', (request) => callOpenAIQuestionGeneration('groq', request, operationDeadline)],
        ['OpenRouter', (request) => callOpenAIQuestionGeneration('openrouter', request, operationDeadline)]
    ]) {
        try {
            return await call(payload);
        } catch (error) {
            failures.push({ provider, code: error.code || 'PROVIDER_FAILED', reason: sanitizeApiError(error.message) });
        }
    }
    throw new AIProviderError('ai', 'ALL_PROVIDERS_FAILED', 'All configured AI providers were unable to generate questions. Please try again later.', {
        providers: failures
    });
}

export async function generateQuestions(payload) {
    const context = requestContext(payload);
    const count = Number(payload?.count || 10);
    if (count !== 10) throw new AIProviderError('Gemini', 'INVALID_REQUEST', 'Question generation requires count=10.');

    const request = {
        ...context,
        level: context.difficulty,
        count,
        attemptSeed: payload.attemptSeed || 1
    };
    const valid = [];
    const seen = new Set((Array.isArray(payload.previousQuestionSignatures) ? payload.previousQuestionSignatures : []).map(normalizeText));
    const usedIds = new Set();
    let lastProviderResult;
    const operationDeadline = Date.now() + 90_000;

    for (let batch = 0; batch < MAX_QUESTION_BATCHES && valid.length < count && Date.now() < operationDeadline; batch += 1) {
        const remaining = count - valid.length;
        lastProviderResult = await callQuestionGenerationProvider({
            ...request,
            count: remaining,
            previousQuestionSignatures: [...seen].slice(-40)
        }, operationDeadline);
        for (const question of lastProviderResult.questions) {
            const signature = questionSignature(question);
            if (!signature || seen.has(signature)) continue;
            seen.add(signature);
            const normalizedQuestion = normalizeQuestionAnswer(question);
            if (!normalizedQuestion || !isQuestionValid(normalizedQuestion, request)) continue;
            let questionId = String(normalizedQuestion.id || '').trim();
            if (!questionId || usedIds.has(questionId)) questionId = `question_${request.attemptSeed}_${randomUUID()}`;
            usedIds.add(questionId);
            valid.push({
                ...normalizedQuestion,
                id: questionId,
                exam: request.exam,
                subject: request.subject,
                topic: request.topic,
                difficulty: request.difficulty,
                level: request.difficulty,
                questionNumber: valid.length + 1
            });
            if (valid.length === count) break;
        }
    }

    if (valid.length !== count) {
        throw new AIProviderError('Gemini', 'INSUFFICIENT_VALID_QUESTIONS', `Gemini returned ${valid.length} of ${count} valid unique questions after ${MAX_QUESTION_BATCHES} batches.`, {
            model: lastProviderResult?.model,
            keyIndex: lastProviderResult?.keyIndex,
            reason: 'The generated questions did not pass context, uniqueness, or answer validation.'
        });
    }
    return valid;
}

export async function generateNotes(payload) {
    const context = requestContext(payload);
    const prompt = `
You create study notes for competitive exam preparation. Return only one JSON object with exactly these fields:
{"title":"...","exam":"${context.exam}","subject":"${context.subject}","topic":"${context.topic}","overview":"...","concepts":["..."],"rules":["..."],"formulas":["..."],"examples":["..."],"shortcuts":["..."],"commonMistakes":["..."],"examTips":["..."],"quickRevision":["..."]}
Use ONLY this selected context:
Exam: ${context.exam}
Subject: ${context.subject}
Topic: ${context.topic}
Difficulty: ${context.difficulty}
Every explanation, rule, formula, and example must match this exact subject and topic. Do not discuss unrelated topics or another subject. Every list must contain useful strings. No markdown or text outside JSON.
`;
    const parseNotes = (data) => {
        const json = parseJsonLike(data?.choices?.[0]?.message?.content || '');
        const geminiText = data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') || '';
        const normalizedJson = json || parseJsonLike(geminiText);
        if (!normalizedJson || normalizedJson.exam !== context.exam || normalizedJson.subject !== context.subject || normalizedJson.topic !== context.topic) return null;
        const asList = (value) => (Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean);
        const notes = {
            title: String(normalizedJson.title || '').trim(),
            exam: context.exam,
            subject: context.subject,
            topic: context.topic,
            overview: String(normalizedJson.overview || '').trim(),
            concepts: asList(normalizedJson.concepts),
            rules: asList(normalizedJson.rules),
            formulas: asList(normalizedJson.formulas),
            examples: asList(normalizedJson.examples),
            shortcuts: asList(normalizedJson.shortcuts),
            commonMistakes: asList(normalizedJson.commonMistakes),
            examTips: asList(normalizedJson.examTips),
            quickRevision: asList(normalizedJson.quickRevision)
        };
        const arrays = Object.entries(notes).filter(([, value]) => Array.isArray(value)).map(([, value]) => value);
        return notes.title && notes.overview && arrays.every((items) => items.length > 0) ? notes : null;
    };
    const failures = [];
    const operationDeadline = Date.now() + PROVIDER_POOL_TIMEOUT_MS;
    for (const providerName of ['groq', 'openrouter', 'gemini']) {
        const displayName = providerName === 'openrouter' ? 'OpenRouter' : providerName[0].toUpperCase() + providerName.slice(1);
        const config = getProviderConfig(providerName);
        try {
            const result = await requestProviderPool(displayName, config, (key, model, signal) => {
                if (providerName === 'gemini') {
                    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
                        method: 'POST',
                        signal,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            systemInstruction: { parts: [{ text: 'Return valid JSON only. Do not add markdown.' }] },
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
                        })
                    });
                }
                const endpoint = providerName === 'groq'
                    ? 'https://api.groq.com/openai/v1/chat/completions'
                    : 'https://openrouter.ai/api/v1/chat/completions';
                return fetch(endpoint, {
                    method: 'POST',
                    signal,
                    headers: {
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json',
                        ...(providerName === 'openrouter' ? {
                            'HTTP-Referer': process.env.OPENROUTER_SITE_URL || process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5173',
                            'X-Title': 'TS Police AI Prep'
                        } : {})
                    },
                    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } })
                });
            }, parseNotes, operationDeadline);
            return result.value;
        } catch (error) {
            failures.push({ provider: displayName, code: error.code || 'PROVIDER_FAILED', reason: sanitizeApiError(error.message) });
        }
    }
    throw new AIProviderError('ai', 'ALL_PROVIDERS_FAILED', 'Configured AI providers could not create valid study notes. Please try again later.', { providers: failures });
}

export async function generateChatReply(payload) {
    const context = requestContext(payload);
    const inputMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    const messages = inputMessages
        .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
        .slice(-20)
        .map(({ role, content }) => ({ role, content: content.slice(0, 8000) }));
    if (!messages.some((message) => message.role === 'user')) {
        throw new AIProviderError('OpenRouter', 'INVALID_REQUEST', 'A user message is required.');
    }

    const syllabusReference = formatChatSyllabus(payload?.syllabus);
    const contextPrompt = `You are an expert tutor for the full TS Police Sub-Inspector and Constable exam syllabus. Support Arithmetic and Quantitative Aptitude, Reasoning, General Studies, Telangana GK, and English. The configured study topics are:\n${syllabusReference || 'Arithmetic, Reasoning, General Studies, Telangana GK, and English.'}\nTreat this as the app's topic catalog: when asked to outline this app's syllabus, organize these configured topics by subject and do not add topics as if they were in this catalog. The current study focus is Exam: ${context.exam}; Subject: ${context.subject}; Topic: ${context.topic}; Difficulty: ${context.difficulty}. Use that focus only when the question is ambiguous. If the user asks about a different syllabus subject or topic, answer that question directly instead of refusing or forcing it back to the selected focus. Explain concepts clearly, show steps and calculations for numerical problems, and use concise examples or shortcuts where helpful. For requests to explain the SI or Constable syllabus, note that the latest official recruitment notification is authoritative for exam-specific differences. Stay within TS Police exam preparation; if a request is unrelated, politely redirect. Do not claim access to notes, official questions, or facts not provided in the conversation. If an earlier assistant reply incorrectly limited help to one subject, correct it and answer the user's current question.`;
    const failures = [];
    const operationDeadline = Date.now() + PROVIDER_POOL_TIMEOUT_MS;
    for (const providerName of ['openrouter', 'groq', 'gemini']) {
        const displayName = providerName === 'openrouter' ? 'OpenRouter' : providerName[0].toUpperCase() + providerName.slice(1);
        const config = getProviderConfig(providerName);
        try {
            const result = await requestProviderPool(displayName, config, (key, model, signal) => {
                if (providerName === 'gemini') {
                    const contents = messages.map(({ role, content }) => ({
                        role: role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: content }]
                    }));
                    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
                        method: 'POST',
                        signal,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            systemInstruction: { parts: [{ text: contextPrompt }] },
                            contents,
                            generationConfig: { maxOutputTokens: 1024 }
                        })
                    });
                }
                const endpoint = providerName === 'groq'
                    ? 'https://api.groq.com/openai/v1/chat/completions'
                    : 'https://openrouter.ai/api/v1/chat/completions';
                return fetch(endpoint, {
                    method: 'POST',
                    signal,
                    headers: {
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json',
                        ...(providerName === 'openrouter' ? {
                            'HTTP-Referer': process.env.OPENROUTER_SITE_URL || process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5173',
                            'X-Title': 'TS Police AI Prep'
                        } : {})
                    },
                    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'system', content: contextPrompt }, ...messages] })
                });
            }, (data) => {
                const text = providerName === 'gemini'
                    ? data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('')
                    : data?.choices?.[0]?.message?.content;
                return typeof text === 'string' && text.trim() ? text.trim() : null;
            }, operationDeadline);
            return result.value;
        } catch (error) {
            failures.push({ provider: displayName, code: error.code || 'PROVIDER_FAILED', reason: sanitizeApiError(error.message) });
        }
    }
    throw new AIProviderError('ai', 'ALL_PROVIDERS_FAILED', 'Configured AI providers could not answer this question. Please try again later.', { providers: failures });
}

export async function getAiStatus() {
    const gemini = getProviderConfig('gemini');
    const groq = getProviderConfig('groq');
    const openrouter = getProviderConfig('openrouter');
    const drive = validateGoogleDriveConfig();
    const providerStatus = (providerName, config) => {
        const lastSuccessful = lastSuccessfulProviderSelections.get(providerName);
        return {
            available: config.apiKeys.length > 0 && config.models.length > 0,
            configuredKeys: config.keysConfigured,
            configuredModels: config.modelsConfigured,
            activeKeyNumber: lastSuccessful?.activeKeyNumber ?? config.activeKeyNumber,
            activeModel: lastSuccessful?.activeModel ?? config.activeModel,
            lastSuccessful: Boolean(lastSuccessful)
        };
    };
    return {
        gemini: providerStatus('gemini', gemini),
        groq: providerStatus('groq', groq),
        openrouter: providerStatus('openrouter', openrouter),
        googleDrive: {
            configured: drive.configured,
            adminAuthConfigured: drive.adminAuthConfigured,
            available: drive.configured && drive.adminAuthConfigured
        }
    };
}

export default {
    generateQuestions,
    generateNotes,
    generateChatReply,
    getAiStatus
};
