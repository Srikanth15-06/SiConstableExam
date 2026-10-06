import test from 'node:test';
import assert from 'node:assert/strict';

for (const key of Object.keys(process.env)) {
    if (/^(GEMINI|GROQ|OPENROUTER)_(API_KEY|MODEL)_[0-9]+$/.test(key)) delete process.env[key];
}

process.env.GEMINI_API_KEY_1 = 'gemini-invalid-key';
process.env.GEMINI_API_KEY_2 = 'gemini-secondary-key';
process.env.GEMINI_MODEL_1 = 'gemini-retired-model';
process.env.GEMINI_MODEL_2 = 'gemini-working-model';
process.env.GROQ_API_KEY_1 = 'groq-test-key';
process.env.GROQ_API_KEY_2 = 'groq-secondary-key';
process.env.GROQ_MODEL_1 = 'groq-retired-model';
process.env.GROQ_MODEL_2 = 'groq-working-model';
process.env.OPENROUTER_API_KEY_1 = 'openrouter-test-key';
process.env.OPENROUTER_API_KEY_2 = 'openrouter-secondary-key';
process.env.OPENROUTER_MODEL_1 = 'openrouter-test-model';

const { generateQuestions, generateNotes, generateChatReply, getAiStatus } = await import('./ai-service.mjs');
const questionRequest = { exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner', count: 10, attemptSeed: 1 };

function makeQuestions({ subject = 'Arithmetic', topic = 'Percentages', difficulty = 'Beginner', start = 1, count = 10 } = {}) {
    return Array.from({ length: count }, (_, offset) => {
        const number = start + offset;
        return {
            question: `${topic} practice item ${number}: choose the correct result.`,
            options: [`Answer ${number}`, `Alternative ${number}A`, `Alternative ${number}B`, `Alternative ${number}C`],
            correctAnswer: `Answer ${number}`,
            explanation: `This is the verified explanation for item ${number}.`,
            shortcut: `Use the relevant ${topic} rule for item ${number}.`,
            subject,
            topic,
            difficulty
        };
    });
}

function geminiResponse(questions) {
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ questions }) }] } }] }), { status: 200 });
}

async function withFetch(mock, action) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock;
    try {
        return await action();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test('Gemini skips an invalid key, falls through an unavailable model, and rotates to a working key/model', async () => {
    const attempts = [];
    const questions = makeQuestions();
    questions[0].correctAnswer = 'B';
    const result = await withFetch(async (url) => {
        const requestUrl = new URL(url);
        const model = requestUrl.pathname.split('/').at(-1).split(':')[0];
        const key = requestUrl.searchParams.get('key');
        attempts.push({ model, key });
        if (key === 'gemini-invalid-key') return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 403 });
        if (model === 'gemini-retired-model') return new Response(JSON.stringify({ error: { message: 'Model not found' } }), { status: 404 });
        return geminiResponse(questions);
    }, () => generateQuestions(questionRequest));

    assert.equal(result.length, 10);
    assert.equal(result[0].correctAnswer, result[0].options[1]);
    assert.ok(result.every((question) => question.id));
    assert.equal(new Set(result.map((question) => question.id)).size, 10);
    assert.deepEqual(attempts, [
        { model: 'gemini-retired-model', key: 'gemini-invalid-key' },
        { model: 'gemini-retired-model', key: 'gemini-secondary-key' },
        { model: 'gemini-working-model', key: 'gemini-secondary-key' }
    ]);
    const status = await getAiStatus();
    assert.equal(status.gemini.activeKeyNumber, 2);
    assert.equal(status.gemini.activeModel, 'gemini-working-model');
    assert.equal(status.gemini.lastSuccessful, true);
});

test('Gemini requests replacement questions for leaked topics and incorrect percentage calculations', async () => {
    let batch = 0;
    const result = await withFetch(async () => {
        batch += 1;
        if (batch === 1) {
            const questions = makeQuestions({ start: 1, count: 8 });
            questions.push({ ...makeQuestions({ subject: 'English', topic: 'Sentences', start: 9, count: 1 })[0] });
            questions.push({
                question: 'What is 20% of 500?',
                options: ['150', '100', '200', '250'],
                correctAnswer: '150',
                explanation: 'Incorrect arithmetic response for validation coverage.',
                shortcut: 'Check the percentage product.',
                subject: 'Arithmetic',
                topic: 'Percentages',
                difficulty: 'Beginner'
            });
            return geminiResponse(questions);
        }
        return geminiResponse(makeQuestions({ start: 11, count: 2 }));
    }, () => generateQuestions(questionRequest));

    assert.equal(batch, 2);
    assert.equal(result.length, 10);
    assert.ok(result.every((question) => question.subject === 'Arithmetic' && question.topic === 'Percentages'));
    assert.ok(result.every((question) => !question.question.includes('20% of 500')));
});

test('question generation falls back from Gemini to Groq and still validates the result', async () => {
    const providers = [];
    const result = await withFetch(async (url, options) => {
        const target = String(url);
        if (target.includes('generativelanguage.googleapis.com')) {
            providers.push('Gemini');
            return new Response(JSON.stringify({ error: { message: 'Gemini unavailable' } }), { status: 503 });
        }
        providers.push('Groq');
        const model = JSON.parse(options.body).model;
        if (model === 'groq-retired-model') return new Response(JSON.stringify({ error: { message: 'Model not found' } }), { status: 404 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: makeQuestions() }) } }] }), { status: 200 });
    }, () => generateQuestions(questionRequest));

    assert.equal(result.length, 10);
    assert.ok(result.every((question) => question.correctAnswer && question.topic === 'Percentages'));
    assert.ok(providers.includes('Gemini'));
    assert.ok(providers.includes('Groq'));
});

test('Groq returns structured notes for only the requested context', async () => {
    let calledUrl = '';
    const notes = {
        title: 'English Sentences: Beginner Notes',
        exam: 'TS SI',
        subject: 'English',
        topic: 'Sentences',
        overview: 'Sentence structure and meaning for English exam questions.',
        concepts: ['Subject and predicate'],
        rules: ['A complete sentence expresses a complete thought.'],
        formulas: ['Subject + verb + complement'],
        examples: ['The candidate answered clearly.'],
        shortcuts: ['Find the main verb first.'],
        commonMistakes: ['Using a fragment as a complete sentence.'],
        examTips: ['Check subject-verb agreement.'],
        quickRevision: ['Identify the subject and its verb.']
    };
    const result = await withFetch(async (url) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(notes) } }] }), { status: 200 });
    }, () => generateNotes({ exam: 'TS SI', subject: 'English', topic: 'Sentences', difficulty: 'Beginner' }));

    assert.match(calledUrl, /api\.groq\.com/);
    assert.equal(result.subject, 'English');
    assert.equal(result.topic, 'Sentences');
    assert.ok(Array.isArray(result.formulas));
});

test('structured notes fall back from Groq to OpenRouter after provider failure', async () => {
    const notes = {
        title: 'Percentages', exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', overview: 'Percentage notes.',
        concepts: ['A percent is a value per hundred.'], rules: ['Convert percent to a fraction over 100.'],
        formulas: ['p% of n = p*n/100'], examples: ['20% of 500 is 100.'], shortcuts: ['10% is one tenth.'],
        commonMistakes: ['Do not omit the percent conversion.'], examTips: ['Estimate first.'], quickRevision: ['100% equals the whole.']
    };
    const providers = [];
    const result = await withFetch(async (url, options) => {
        const target = String(url);
        if (target.includes('api.groq.com')) {
            providers.push('Groq');
            return new Response(JSON.stringify({ error: { message: 'Groq unavailable' } }), { status: 503 });
        }
        providers.push('OpenRouter');
        const key = options.headers.Authorization.replace('Bearer ', '');
        if (key === 'openrouter-test-key') return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(notes) } }] }), { status: 200 });
    }, () => generateNotes({ exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner' }));

    assert.equal(result.topic, 'Percentages');
    assert.ok(providers.includes('Groq'));
    assert.ok(providers.includes('OpenRouter'));
});

test('Groq and OpenRouter move to the next key when the first key is rejected', async () => {
    const attempts = [];
    const notes = {
        title: 'Percentages', exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', overview: 'Percentage notes.',
        concepts: ['A percent is a value per hundred.'], rules: ['Convert percent to a fraction over 100.'],
        formulas: ['p% of n = p*n/100'], examples: ['20% of 500 is 100.'], shortcuts: ['10% is one tenth.'],
        commonMistakes: ['Do not omit the percent conversion.'], examTips: ['Estimate first.'], quickRevision: ['100% equals the whole.']
    };
    await withFetch(async (url, options) => {
        const provider = String(url).includes('groq.com') ? 'Groq' : 'OpenRouter';
        const key = options.headers.Authorization.replace('Bearer ', '');
        attempts.push({ provider, key });
        if (key.endsWith('test-key')) return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 });
        return provider === 'Groq'
            ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(notes) } }] }), { status: 200 })
            : new Response(JSON.stringify({ choices: [{ message: { content: 'OpenRouter rotated successfully.' } }] }), { status: 200 });
    }, async () => {
        await generateNotes({ exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner' });
        await generateChatReply({ exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner', messages: [{ role: 'user', content: 'Explain percentages.' }] });
    });

    assert.deepEqual(attempts, [
        { provider: 'Groq', key: 'groq-test-key' },
        { provider: 'Groq', key: 'groq-secondary-key' },
        { provider: 'OpenRouter', key: 'openrouter-test-key' },
        { provider: 'OpenRouter', key: 'openrouter-secondary-key' }
    ]);
});

test('chat uses OpenRouter and includes the selected context and conversation history', async () => {
    let call;
    const reply = await withFetch(async (url, options) => {
        call = { url: String(url), body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ choices: [{ message: { content: 'A dynamically generated tutor response.' } }] }), { status: 200 });
    }, () => generateChatReply({
        exam: 'TS SI',
        subject: 'Arithmetic',
        topic: 'Percentages',
        difficulty: 'Beginner',
        messages: [{ role: 'user', content: 'How do I find 20% of a number?' }]
    }));

    assert.match(call.url, /openrouter\.ai/);
    assert.match(call.body.messages[0].content, /Topic: Percentages/);
    assert.equal(call.body.messages[1].content, 'How do I find 20% of a number?');
    assert.equal(reply, 'A dynamically generated tutor response.');
});

test('tutor chat falls back from OpenRouter to Groq after provider failure', async () => {
    const providers = [];
    const reply = await withFetch(async (url) => {
        if (String(url).includes('openrouter.ai')) {
            providers.push('OpenRouter');
            return new Response(JSON.stringify({ error: { message: 'OpenRouter unavailable' } }), { status: 503 });
        }
        providers.push('Groq');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'A fallback tutoring response.' } }] }), { status: 200 });
    }, () => generateChatReply({
        exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner',
        messages: [{ role: 'user', content: 'Explain percentages.' }]
    }));

    assert.equal(reply, 'A fallback tutoring response.');
    assert.ok(providers.includes('OpenRouter'));
    assert.ok(providers.includes('Groq'));
});

test('chat supports the full TS Police syllabus outside the selected study focus', async () => {
    let systemPrompt = '';
    await withFetch(async (_url, options) => {
        systemPrompt = JSON.parse(options.body).messages[0].content;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Parts of speech include nouns, verbs, adjectives, and more.' } }] }), { status: 200 });
    }, () => generateChatReply({
        exam: 'TS Constable',
        subject: 'Arithmetic',
        topic: 'Percentages',
        difficulty: 'Beginner',
        syllabus: {
            Arithmetic: ['Percentages'],
            Reasoning: ['Number Series'],
            'General Studies': ['Indian Polity'],
            'Telangana GK': ['Telangana Formation'],
            English: ['Parts of Speech', 'Tenses'],
            Unlisted: ['Do not include this subject']
        },
        messages: [{ role: 'user', content: 'Explain parts of speech and Telangana Formation Day.' }]
    }));

    assert.match(systemPrompt, /full TS Police Sub-Inspector and Constable exam syllabus/);
    for (const subject of ['Arithmetic', 'Reasoning', 'General Studies', 'Telangana GK', 'English']) {
        assert.ok(systemPrompt.includes(subject), `Expected tutor scope to include ${subject}.`);
    }
    assert.match(systemPrompt, /answer that question directly instead of refusing/);
    assert.match(systemPrompt, /English: Parts of Speech; Tenses/);
    assert.match(systemPrompt, /Telangana GK: Telangana Formation/);
    assert.doesNotMatch(systemPrompt, /Writing Skills|Do not include this subject/);
    assert.doesNotMatch(systemPrompt, /Answer only in the selected context/);
});

test('Groq falls back from unavailable models and cools down rate-limited keys', async () => {
    const attempts = [];
    const notes = {
        title: 'Percentages', exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', overview: 'Percentage notes.',
        concepts: ['A percent is a value per hundred.'], rules: ['Convert percent to a fraction over 100.'],
        formulas: ['p% of n = p*n/100'], examples: ['20% of 500 is 100.'], shortcuts: ['10% is one tenth.'],
        commonMistakes: ['Do not omit the percent conversion.'], examTips: ['Estimate first.'], quickRevision: ['100% equals the whole.']
    };
    await withFetch(async (url, options) => {
        const authorization = options.headers.Authorization;
        const key = authorization.replace('Bearer ', '');
        const model = JSON.parse(options.body).model;
        attempts.push({ key, model });
        if (key === 'groq-test-key') return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429 });
        if (model === 'groq-retired-model') return new Response(JSON.stringify({ error: { message: 'Model not found' } }), { status: 404 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(notes) } }] }), { status: 200 });
    }, async () => {
        await generateNotes({ exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner' });
        await generateNotes({ exam: 'TS SI', subject: 'Arithmetic', topic: 'Percentages', difficulty: 'Beginner' });
    });

    assert.deepEqual(attempts, [
        { key: 'groq-test-key', model: 'groq-retired-model' },
        { key: 'groq-secondary-key', model: 'groq-retired-model' },
        { key: 'groq-secondary-key', model: 'groq-working-model' },
        { key: 'groq-secondary-key', model: 'groq-retired-model' },
        { key: 'groq-secondary-key', model: 'groq-working-model' }
    ]);
});