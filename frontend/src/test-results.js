const numericAnswerPattern = /^([+-]?)(?:(\d{1,3}(?:,\d{3})+)|\d+)(\.\d+)?\s*(%)?$/;

export function normalizeAnswer(value) {
    if (value === null || value === undefined) return '';
    const normalized = String(value)
        .normalize('NFKC')
        .trim()
        .toLocaleLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, ' ');
    if (!normalized) return '';

    const numericMatch = normalized.match(numericAnswerPattern);
    if (numericMatch) {
        const sign = numericMatch[1] === '+' ? '' : numericMatch[1];
        const integer = (numericMatch[2] || normalized.match(/^([+-]?)(\d+)/)?.[2] || '0').replace(/,/g, '').replace(/^0+(?=\d)/, '');
        let decimal = (numericMatch[3] || '').replace(/0+$/, '');
        if (decimal === '.') decimal = '';
        const isNegativeZero = sign === '-' && Number(`${integer}${decimal || '.0'}`) === 0;
        return `${isNegativeZero ? '' : sign}${integer}${decimal}${numericMatch[4] ? '%' : ''}`;
    }

    return normalized
        .replace(/\s*%\s*/g, '%')
        .replace(/[\s.,!?;:]+$/g, '')
        .replace(/\s+/g, ' ');
}

export function calculateTestResult(questions, answers) {
    const questionList = Array.isArray(questions) ? questions : [];
    const answerMap = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
    const activeIds = new Set(questionList.map((question) => question?.id).filter(Boolean));
    const safeAnswers = Object.fromEntries(
        Object.entries(answerMap).filter(([questionId, answer]) => activeIds.has(questionId) && typeof answer === 'string')
    );

    const details = questionList.map((question) => {
        const userAnswer = question?.id ? safeAnswers[question.id] || '' : '';
        const isAnswered = Boolean(normalizeAnswer(userAnswer));
        const isCorrect = isAnswered && normalizeAnswer(userAnswer) === normalizeAnswer(question?.correctAnswer);
        return {
            questionId: question?.id || '',
            question: question?.question || '',
            options: Array.isArray(question?.options) ? question.options : [],
            userAnswer,
            correctAnswer: question?.correctAnswer || '',
            isCorrect,
            status: !isAnswered ? 'UNANSWERED' : isCorrect ? 'CORRECT' : 'INCORRECT',
            explanation: question?.explanation || '',
            shortcut: question?.shortcut || ''
        };
    });

    const correct = details.filter((detail) => detail.isCorrect).length;
    const unanswered = details.filter((detail) => detail.status === 'UNANSWERED').length;
    const incorrect = details.length - correct - unanswered;
    const percentage = details.length ? Math.round((correct / details.length) * 100) : 0;

    return {
        correct,
        incorrect,
        unanswered,
        total: details.length,
        percentage,
        accuracy: percentage,
        details
    };
}