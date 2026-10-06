import fs from 'node:fs';
import path from 'node:path';
import { validateGoogleDriveConfig } from './google-drive-service.mjs';

const envPath = path.resolve(process.cwd(), '.env');

function hasActiveProviderConfig() {
    const providerPrefixes = ['GEMINI', 'GROQ', 'OPENROUTER'];
    return providerPrefixes.some((prefix) => {
        const directKey = process.env[`${prefix}_API_KEY`];
        if (typeof directKey === 'string' && directKey.trim()) return true;
        for (let index = 1; index <= 20; index += 1) {
            if (typeof process.env[`${prefix}_API_KEY_${index}`] === 'string' && process.env[`${prefix}_API_KEY_${index}`].trim()) {
                return true;
            }
            if (typeof process.env[`${prefix}_MODEL_${index}`] === 'string' && process.env[`${prefix}_MODEL_${index}`].trim()) {
                return true;
            }
        }
        return false;
    });
}

function loadDotEnv() {
    if (hasActiveProviderConfig()) return;
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) {
            process.env[key] = value.replace(/^['"]|['"]$/g, '');
        }
    }
}

loadDotEnv();

export function getProviderConfig(providerName) {
    const providerKey = providerName.toUpperCase();
    const apiKeys = [];
    const apiKeyEntries = [];
    let index = 1;

    while (index <= 20) {
        const key = process.env[`${providerKey}_API_KEY_${index}`];
        if (key && key.trim()) {
            const trimmedKey = key.trim();
            apiKeys.push(trimmedKey);
            apiKeyEntries.push({ index, key: trimmedKey });
        }
        index += 1;
    }

    const modelEntries = [];
    const models = [];
    let modelIndex = 1;
    while (modelIndex <= 20) {
        const model = process.env[`${providerKey}_MODEL_${modelIndex}`];
        if (model && model.trim()) {
            const trimmedModel = model.trim();
            modelEntries.push({ index: modelIndex, model: trimmedModel });
            models.push(trimmedModel);
        }
        modelIndex += 1;
    }

    const activeIndex = (() => {
        const candidateIndexes = new Set([...apiKeyEntries.map((entry) => entry.index), ...modelEntries.map((entry) => entry.index)]);
        const activeSlot = Array.from(candidateIndexes).sort((left, right) => left - right).find((candidate) => {
            return apiKeyEntries.some((entry) => entry.index === candidate) && modelEntries.some((entry) => entry.index === candidate);
        });
        if (typeof activeSlot === 'number') return activeSlot;
        if (apiKeyEntries[0]?.index != null) return apiKeyEntries[0].index;
        if (modelEntries[0]?.index != null) return modelEntries[0].index;
        return null;
    })();

    const activeKeyEntry = apiKeyEntries.find((entry) => entry.index === activeIndex) || apiKeyEntries[0] || null;
    const activeModelEntry = modelEntries.find((entry) => entry.index === activeIndex) || modelEntries[0] || null;

    return {
        providerName,
        apiKeys,
        apiKeyEntries,
        models,
        modelEntries,
        keysConfigured: apiKeys.length,
        modelsConfigured: models.length,
        activeKeyNumber: activeKeyEntry?.index ?? null,
        activeKey: activeKeyEntry?.key ?? null,
        activeModel: activeModelEntry?.model ?? null
    };
}

export function getAllProviderStatus() {
    const drive = validateGoogleDriveConfig();
    return {
        gemini: getProviderConfig('gemini'),
        groq: getProviderConfig('groq'),
        openrouter: getProviderConfig('openrouter'),
        googleDrive: {
            ...drive,
            available: drive.configured && drive.adminAuthConfigured
        }
    };
}

export function sanitizeApiError(error) {
    if (!error) return 'Unknown provider error';
    const message = typeof error === 'string' ? error : error.message || String(error);
    return message
        .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
        .replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, '[REDACTED]')
        .replace(/sk-[A-Za-z0-9_-]+/gi, '[REDACTED]')
        .replace(/gsk_[A-Za-z0-9_-]+/gi, '[REDACTED]');
}

export function describeAiFailure(error, fallbackMessage = 'The AI service is temporarily unavailable. Please try again in a moment.') {
    const raw = typeof error === 'string' ? error : (error?.message || String(error || ''));
    const message = raw.toLowerCase();

    if (!raw) return fallbackMessage;
    if (/not configured|missing.*key|api key|unauthorized|forbidden|authentication|invalid api/i.test(message)) {
        return 'The AI service is not configured correctly. Please contact the maintainer.';
    }
    if (/model .* does not exist|does not exist|invalid model|unknown model|unsupported model/i.test(message)) {
        return 'The selected AI model is unavailable. Please try a different topic or try again soon.';
    }
    if (/rate limit|quota|too many requests|temporar|timeout|network|service unavailable|overloaded|connection/i.test(message)) {
        return 'The AI service is temporarily busy. Please try again in a moment.';
    }
    return fallbackMessage;
}
