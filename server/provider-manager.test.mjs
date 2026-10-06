import test from 'node:test';
import assert from 'node:assert/strict';

for (const key of Object.keys(process.env)) {
    if (/^(GEMINI|GROQ|OPENROUTER)_(API_KEY|MODEL)_[0-9]+$/.test(key)) {
        delete process.env[key];
    }
}

process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
process.env.GEMINI_API_KEY_3 = 'gemini-key-3';
process.env.GEMINI_MODEL_1 = 'gemini-model-1';
process.env.GEMINI_MODEL_2 = 'gemini-model-2';

process.env.GROQ_API_KEY_1 = 'groq-key-1';
process.env.GROQ_API_KEY_2 = 'groq-key-2';
process.env.GROQ_MODEL_1 = 'groq-model-1';

process.env.OPENROUTER_API_KEY_1 = 'openrouter-key-1';
process.env.OPENROUTER_API_KEY_2 = 'openrouter-key-2';
process.env.OPENROUTER_MODEL_1 = 'openrouter-model-1';

const { getProviderConfig } = await import('./provider-manager.mjs');

test('provider config loads configured keys and models', () => {
    const gemini = getProviderConfig('gemini');
    const groq = getProviderConfig('groq');
    const openrouter = getProviderConfig('openrouter');

    assert.deepEqual(gemini.apiKeys, ['gemini-key-1', 'gemini-key-2', 'gemini-key-3']);
    assert.deepEqual(gemini.models, ['gemini-model-1', 'gemini-model-2']);
    assert.equal(gemini.activeKeyNumber, 1);
    assert.equal(gemini.activeModel, 'gemini-model-1');

    assert.deepEqual(groq.apiKeys, ['groq-key-1', 'groq-key-2']);
    assert.deepEqual(groq.models, ['groq-model-1']);
    assert.equal(groq.activeKeyNumber, 1);
    assert.equal(groq.activeModel, 'groq-model-1');

    assert.deepEqual(openrouter.apiKeys, ['openrouter-key-1', 'openrouter-key-2']);
    assert.deepEqual(openrouter.models, ['openrouter-model-1']);
    assert.equal(openrouter.activeKeyNumber, 1);
    assert.equal(openrouter.activeModel, 'openrouter-model-1');
});
