import { randomBytes, randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { expect, test } from 'playwright/test';

dotenv.config({ quiet: true });
const { getSupabaseClient } = await import('../server/supabase-client.mjs');
const supabase = getSupabaseClient();
const baseURL = process.env.BASE_URL || 'http://localhost:8812';
const localTarget = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname);

function monitorPage(page) {
    const failures = { pageErrors: 0, consoleErrors: 0, localRequestFailures: [], unexpectedClientErrors: [], localServerErrors: [] };
    const appOrigin = new URL(baseURL).origin;
    page.on('pageerror', () => failures.pageErrors += 1);
    page.on('console', (message) => {
        if (message.type() === 'error' && !/\b(?:401|404)\b/.test(message.text())) failures.consoleErrors += 1;
    });
    page.on('requestfailed', (request) => {
        try {
            const url = new URL(request.url());
            if (url.origin === appOrigin) failures.localRequestFailures.push(url.pathname);
        } catch {
            failures.localRequestFailures.push('invalid-local-url');
        }
    });
    page.on('response', (response) => {
        if (!response.url().startsWith(appOrigin)) return;
        const pathname = new URL(response.url()).pathname;
        const status = response.status();
        if (status >= 500) failures.localServerErrors.push({ path: pathname, status });
        if (status >= 400 && status < 500) {
            const expected = (status === 401 && ['/api/auth/me', '/api/auth/login', '/api/me/data'].includes(pathname))
                || (status === 404 && (/^\/api\/tests\/[^/]+$/.test(pathname) || /^\/api\/users\/[^/]+\/progress$/.test(pathname)));
            if (!expected) failures.unexpectedClientErrors.push({ path: pathname, status });
        }
    });
    return failures;
}

async function removeTemporaryAccount(email) {
    const account = await supabase.from('app_users').select('id').eq('email', email).maybeSingle();
    if (account.error) throw new Error('Temporary account cleanup lookup failed.');
    if (account.data?.id) {
        const removed = await supabase.from('app_users').delete().eq('id', account.data.id).select('id');
        if (removed.error || removed.data?.length !== 1) throw new Error('Temporary account cleanup failed.');
        for (const table of ['app_sessions', 'app_user_state', 'user_progress', 'quiz_attempts', 'planner_documents', 'user_history', 'user_notes']) {
            const remaining = await supabase.from(table).select('user_id', { head: true, count: 'exact' }).eq('user_id', account.data.id);
            if (remaining.error || (remaining.count || 0) !== 0) throw new Error('Temporary account data cleanup failed.');
        }
    }
    const remaining = await supabase.from('app_users').select('id', { head: true, count: 'exact' }).eq('email', email);
    if (remaining.error || (remaining.count || 0) !== 0) throw new Error('Temporary account remained after cleanup.');
}

async function readCurrentData(page, userId = '') {
    return page.evaluate(async (requestedUserId) => {
        const query = requestedUserId ? `?userId=${encodeURIComponent(requestedUserId)}` : '';
        const response = await fetch(`/api/me/data${query}`);
        return { status: response.status, body: await response.json() };
    }, userId);
}

function expectNoResponseSecrets(value, passwords) {
    const serialized = JSON.stringify(value);
    const secretField = /"[^"\r\n]*(?:passwordhash|password_hash|token_hash|encrypted_payload|service_role_key|session_secret|google_client_secret|access_token|refresh_token)[^"\r\n]*"\s*:/i;
    expect(secretField.test(serialized)).toBe(false);
    for (const password of passwords) expect(serialized.includes(password)).toBe(false);
}

test('@desktop signup, login, planner, quiz, isolation, Drive status, and logout flow', async ({ page, context }) => {
    test.setTimeout(300_000);
    test.skip(!localTarget, 'Mutating account E2E tests are restricted to a local production server.');

    const failures = monitorPage(page);
    const apiSequence = [];
    const appOrigin = new URL(baseURL).origin;
    page.on('request', (request) => {
        if (!request.url().startsWith(appOrigin)) return;
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith('/api/')) return;
        const entry = { method: request.method(), path: pathname };
        if (pathname === '/api/me/planner' && request.method() === 'PUT') entry.expectedRevision = request.postDataJSON()?.expectedRevision;
        apiSequence.push(entry);
    });
    page.on('response', (response) => {
        if (!response.url().startsWith(appOrigin)) return;
        const pathname = new URL(response.url()).pathname;
        const entry = apiSequence.findLast((item) => !Object.hasOwn(item, 'status') && item.path === pathname && item.method === response.request().method());
        if (!entry) return;
        entry.status = response.status();
        if (pathname === '/api/me/data') {
            void response.json().then((body) => { entry.plannerRevision = body.data?.plannerRevision ?? null; }).catch(() => undefined);
        }
    });
    const runId = randomUUID();
    const accounts = [
        { email: `integration-test-playwright-${runId}-a@example.invalid`, name: 'Playwright Candidate A', password: randomBytes(32).toString('base64url') },
        { email: `integration-test-playwright-${runId}-b@example.invalid`, name: 'Playwright Candidate B', password: randomBytes(32).toString('base64url') }
    ];
    let userAId = '';
    let userBAttemptId = '';
    let questionAttemptId = '';
    const plannerWriteMetadata = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/me/planner' && request.method() === 'PUT') {
            plannerWriteMetadata.push({ expectedRevision: request.postDataJSON()?.expectedRevision });
        }
    });
    page.on('response', async (response) => {
        if (new URL(response.url()).pathname === '/api/me/planner') {
            const body = await response.json().catch(() => ({}));
            plannerWriteMetadata.push({ status: response.status(), code: body.code || null, revision: body.plannerRevision ?? null });
        }
    });

    try {
        await page.goto('/');
        expect(await page.title()).toBe('TS Police AI Prep');
        await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

        await page.getByRole('button', { name: 'Sign up', exact: true }).click();
        await expect(page.getByLabel('Full name')).toBeVisible();
        await page.getByLabel('Full name').fill(accounts[0].name);
        await page.getByLabel('Email address').fill(accounts[0].email);
        await page.getByLabel('Password').fill(accounts[0].password);
        const signupResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/signup');
        await page.locator('form').getByRole('button', { name: 'Create account', exact: true }).click();
        const signupResponse = await signupResponsePromise;
        expect(signupResponse.status()).toBe(202);
        const signupBody = await signupResponse.json();
        expectNoResponseSecrets(signupBody, accounts.map((account) => account.password));
        const signupHeaders = await signupResponse.allHeaders();
        expect(signupHeaders['set-cookie']).toBeUndefined();
        await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
        await expect(page.getByRole('status')).toContainText('Please sign in to continue');

        const userARow = await supabase.from('app_users').select('id').eq('email', accounts[0].email).maybeSingle();
        if (userARow.error || !userARow.data?.id) throw new Error('Temporary account was not created.');
        userAId = userARow.data.id;

        await page.getByLabel('Password').fill('wrong-password-for-e2e');
        const wrongLoginPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login');
        await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
        const wrongLogin = await wrongLoginPromise;
        expect(wrongLogin.status()).toBe(401);
        expectNoResponseSecrets(await wrongLogin.json(), accounts.map((account) => account.password));
        expect((await wrongLogin.allHeaders())['set-cookie']).toBeUndefined();
        await expect(page.getByRole('alert')).toContainText('incorrect');

        await page.getByLabel('Email address').fill(`integration-test-playwright-${runId}-missing@example.invalid`);
        const missingLoginPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login');
        await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
        const missingLogin = await missingLoginPromise;
        expect(missingLogin.status()).toBe(401);
        expect((await missingLogin.allHeaders())['set-cookie']).toBeUndefined();

        await page.getByLabel('Email address').fill(accounts[0].email);
        await page.getByLabel('Password').fill(accounts[0].password);
        const loginResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login');
        await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
        const loginResponse = await loginResponsePromise;
        expect(loginResponse.status()).toBe(200);
        const loginBody = await loginResponse.json();
        expect(loginBody.user?.userId === userAId && loginBody.user?.email === accounts[0].email).toBe(true);
        expectNoResponseSecrets(loginBody, accounts.map((account) => account.password));
        const cookie = (await loginResponse.allHeaders())['set-cookie'] || '';
        const cookieFlags = { httpOnly: /httponly/i.test(cookie), secure: /secure/i.test(cookie), sameSiteLax: /samesite=lax/i.test(cookie) };
        expect(cookieFlags).toEqual({ httpOnly: true, secure: true, sameSiteLax: true });
        await expect(page.getByRole('heading', { name: `Welcome, ${accounts[0].name}!` })).toBeVisible();

        const reopenedContext = await page.context().browser().newContext({ storageState: await context.storageState() });
        const reopenedPage = await reopenedContext.newPage();
        try {
            await reopenedPage.goto('/');
            await expect(reopenedPage.getByRole('heading', { name: `Welcome, ${accounts[0].name}!` })).toBeVisible();
            const reopenedMe = await reopenedPage.evaluate(async () => (await fetch('/api/auth/me')).status);
            expect(reopenedMe).toBe(200);
        } finally {
            await reopenedContext.close();
        }

        const me = await page.evaluate(async () => {
            const response = await fetch('/api/auth/me');
            return { status: response.status, body: await response.json() };
        });
        expect(me.status === 200 && me.body.user?.userId === userAId).toBe(true);
        expectNoResponseSecrets(me.body, accounts.map((account) => account.password));
        const storageKeys = await page.evaluate(() => Object.keys(localStorage));
        expect(storageKeys.some((key) => /candidate|user.?state|progress|test.?history|session/i.test(key))).toBe(false);

        await page.getByRole('button', { name: 'Smart Study Planner', exact: true }).click();
        await expect(page.getByRole('heading', { name: /preparation plan/i })).toBeVisible();
        const plannerNote = `playwright temporary planner ${runId}`;
        await page.getByLabel('Notes').fill(plannerNote);
        const plannerStateBefore = await readCurrentData(page);
        const plannerDocumentBefore = await supabase.from('planner_documents').select('revision').eq('user_id', userAId).maybeSingle();
        if (plannerDocumentBefore.error) throw new Error('Planner revision fixture read failed.');
        const plannerResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/me/planner' && response.request().method() === 'PUT');
        await page.getByRole('button', { name: 'Add task to calendar', exact: true }).click();
        const plannerResponse = await plannerResponsePromise;
        const conflictBody = plannerResponse.status() === 409 ? await plannerResponse.json().catch(() => ({})) : {};
        expect(plannerResponse.status(), JSON.stringify({ plannerWriteMetadata, apiRevisionBefore: plannerStateBefore.body.data?.plannerRevision, documentRevisionBefore: plannerDocumentBefore.data?.revision, code: conflictBody.code || null, apiSequence })).toBe(200);
        const plannerBody = await plannerResponse.json();
        expect(plannerBody.plannerData.schedule.some((task) => task.notes === plannerNote)).toBe(true);
        await expect.poll(async () => {
            const data = await readCurrentData(page);
            return data.status === 200 && data.body.data?.plannerData?.schedule?.some((task) => task.notes === plannerNote) === true;
        }, { timeout: 20_000 }).toBe(true);
        const plannerSnapshot = await readCurrentData(page);
        const plannerTask = plannerSnapshot.body.data.plannerData.schedule.find((task) => task.notes === plannerNote);
        expect(plannerTask?.userId === userAId).toBe(true);

        await page.getByRole('button', { name: 'Syllabus & Tests', exact: true }).click();
        await page.getByRole('button', { name: 'Arithmetic', exact: true }).click();
        await page.getByText('Percentages', { exact: true }).first().click();
        await expect(page.getByRole('heading', { name: 'Select Topic & Practice Level' })).toBeVisible();
        const createAttemptPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tests' && response.request().method() === 'POST', { timeout: 150_000 });
        await page.getByRole('button', { name: 'Launch AI Test', exact: true }).click();
        const createAttemptResponse = await createAttemptPromise;
        expect(createAttemptResponse.status()).toBe(201);
        const attemptBody = await createAttemptResponse.json();
        const attempt = attemptBody.attempt;
        questionAttemptId = attempt?.attemptId || '';
        expect(attempt?.status === 'in_progress' && attempt.questions?.length === 10).toBe(true);
        expectNoResponseSecrets(attemptBody, accounts.map((account) => account.password));
        const serializedAttempt = JSON.stringify(attemptBody);
        expect(/"(?:correctAnswer|answerKey|solutionKey|explanation|shortcut)"\s*:/i.test(serializedAttempt)).toBe(false);
        await expect(page.getByRole('timer')).toBeVisible();
        await expect(page.getByText('Question 1 of 10', { exact: true })).toBeVisible();

        const firstOption = attempt.questions[0].options[0];
        await page.getByRole('button', { name: firstOption, exact: true }).click();
        await expect(page.getByText('Answered', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Submit Test', exact: true }).click();
        const submitPromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/tests/${questionAttemptId}/submit`);
        await page.getByRole('button', { name: 'Submit Now', exact: true }).click();
        const submitted = await submitPromise;
        expect(submitted.status()).toBe(200);
        const resultBody = await submitted.json();
        expect(resultBody.result?.attemptId === questionAttemptId && resultBody.result?.total === 10).toBe(true);
        await expect(page.getByRole('heading', { name: 'Test Results' })).toBeVisible();

        await page.reload();
        await expect(page.getByRole('heading', { name: `Welcome, ${accounts[0].name}!` })).toBeVisible();
        let persistedA = await readCurrentData(page);
        expect(persistedA.status === 200 && persistedA.body.data.testHistory.some((item) => item.attemptId === questionAttemptId)).toBe(true);
        expect(persistedA.body.data.userProgress['SI|Arithmetic|Percentages']?.attempts === 1 && persistedA.body.data.plannerData.schedule.some((task) => task.notes === plannerNote)).toBe(true);

        await page.getByRole('button', { name: 'Notes Library', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Subjects' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Topic Learning Videos' })).toBeVisible();
        await expect(page.getByLabel('Video Title')).toBeVisible();
        await expect(page.getByLabel('YouTube URL')).toBeVisible();
        await expect(page.getByRole('button', { name: '+ Add YouTube Video' })).toBeVisible();
        const driveStatus = await page.evaluate(async () => {
            const response = await fetch('/api/drive/auth/status');
            return { status: response.status, body: await response.json() };
        });
        expect(driveStatus.status === 200 && typeof driveStatus.body.connected === 'boolean').toBe(true);
        expect(['access_token', 'refresh_token', 'encrypted_payload'].some((name) => Object.hasOwn(driveStatus.body, name))).toBe(false);

        await page.getByTitle('Log out').click();
        await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
        const afterLogout = await page.evaluate(async () => (await fetch('/api/me/data')).status);
        expect(afterLogout).toBe(401);
        await context.addCookies([{ name: 'ts_police_session', value: 'invalid-playwright-session', url: baseURL }]);
        const invalidSession = await page.evaluate(async () => (await fetch('/api/me/data')).status);
        expect(invalidSession).toBe(401);
        await context.clearCookies({ name: 'ts_police_session' });

        await page.getByRole('button', { name: 'Sign up', exact: true }).click();
        await page.getByLabel('Full name').fill(accounts[1].name);
        await page.getByLabel('Email address').fill(accounts[1].email);
        await page.getByLabel('Password').fill(accounts[1].password);
        const signupBPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/signup');
        await page.locator('form').getByRole('button', { name: 'Create account', exact: true }).click();
        expect((await signupBPromise).status()).toBe(202);
        const userBRow = await supabase.from('app_users').select('id').eq('email', accounts[1].email).maybeSingle();
        if (userBRow.error || !userBRow.data?.id) throw new Error('Second temporary account was not created.');
        const userBId = userBRow.data.id;

        await page.getByLabel('Email address').fill(accounts[1].email);
        await page.getByLabel('Password').fill(accounts[1].password);
        const loginBPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login');
        await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
        expect((await loginBPromise).status()).toBe(200);
        await expect(page.getByRole('heading', { name: `Welcome, ${accounts[1].name}!` })).toBeVisible();

        const bData = await readCurrentData(page, userAId);
        expect(bData.status === 200 && bData.body.data.profile.email === accounts[1].email).toBe(true);
        expect(bData.body.data.testHistory.length === 0 && Object.keys(bData.body.data.userProgress).length === 0
            && bData.body.data.plannerData.schedule.length === 0).toBe(true);
        const spoofedProfile = await page.evaluate(async ({ userId }) => {
            const response = await fetch('/api/me/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Playwright Candidate B Updated', exam: 'SI', userId }) });
            return { status: response.status, body: await response.json() };
        }, { userId: userAId });
        expect(spoofedProfile.status === 200 && spoofedProfile.body.user.userId === userBId).toBe(true);
        const bMe = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
        expect(bMe.user?.userId === userBId).toBe(true);
        const crossAttempt = await page.evaluate(async (attemptId) => (await fetch(`/api/tests/${encodeURIComponent(attemptId)}`)).status, questionAttemptId);
        expect(crossAttempt).toBe(404);
        const arbitraryRoute = await page.evaluate(async (userId) => (await fetch(`/api/users/${encodeURIComponent(userId)}/progress`)).status, userAId);
        expect(arbitraryRoute).toBe(404);

        await page.getByTitle('Log out').click();
        const logoutBStatus = await page.evaluate(async () => (await fetch('/api/me/data')).status);
        expect(logoutBStatus).toBe(401);
        await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
        await page.getByLabel('Email address').fill(accounts[0].email);
        await page.getByLabel('Password').fill(accounts[0].password);
        const reloginAPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login');
        await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
        expect((await reloginAPromise).status()).toBe(200);
        const restoredA = await readCurrentData(page);
        expect(restoredA.body.data.profile.email === accounts[0].email && restoredA.body.data.testHistory.some((item) => item.attemptId === questionAttemptId)
            && restoredA.body.data.userProgress['SI|Arithmetic|Percentages']?.attempts === 1 && restoredA.body.data.plannerData.schedule.some((task) => task.notes === plannerNote)).toBe(true);

        const bundleResponse = await page.request.get(new URL((await page.locator('script[type="module"]').first().getAttribute('src')) || '', baseURL).toString());
        const bundle = await bundleResponse.text();
        expect(bundleResponse.ok()).toBe(true);
        expect(/SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE/.test(bundle)).toBe(false);
        expect(failures.pageErrors).toBe(0);
        expect(failures.consoleErrors).toBe(0);
        expect(failures.localRequestFailures.length).toBe(0);
        expect(failures.unexpectedClientErrors).toEqual([]);
        expect(failures.localServerErrors.length).toBe(0);
    } finally {
        for (const account of accounts) await removeTemporaryAccount(account.email);
    }
});

for (const tag of ['mobile', 'tablet']) {
    test(`@${tag} signup layout, keyboard focus, and SPA fallback`, async ({ page }) => {
        const failures = monitorPage(page);
        await page.goto('/profile');
        expect(await page.title()).toBe('TS Police AI Prep');
        await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
        const dimensions = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
        expect(dimensions.documentWidth <= dimensions.width + 1).toBe(true);
        await page.getByRole('button', { name: 'Sign up', exact: true }).click();
        const name = page.getByLabel('Full name');
        const email = page.getByLabel('Email address');
        const password = page.getByLabel('Password');
        await expect(name).toBeVisible();
        await expect(email).toBeVisible();
        await expect(password).toBeVisible();
        await email.focus();
        await expect(email).toBeFocused();
        for (const field of [name, email, password]) {
            const box = await field.boundingBox();
            expect(Boolean(box && box.x >= 0 && box.x + box.width <= dimensions.width + 1)).toBe(true);
        }
        expect(failures.pageErrors).toBe(0);
        expect(failures.consoleErrors).toBe(0);
        expect(failures.localRequestFailures.length).toBe(0);
        expect(failures.unexpectedClientErrors).toEqual([]);
        expect(failures.localServerErrors.length).toBe(0);
    });
}

test('@desktop auth errors and loading are recoverable', async ({ page }) => {
    test.skip(!localTarget, 'Simulated auth responses are restricted to a local production server.');
    await page.goto('/');
    const email = page.getByLabel('Email address');
    const password = page.getByLabel('Password');
    const submit = page.locator('form button[type="submit"]');

    await submit.click();
    expect(await email.evaluate((input) => input.validity.valueMissing)).toBe(true);
    await email.fill('not-an-email');
    await password.fill('temporary-form-validation');
    await submit.click();
    expect(await email.evaluate((input) => input.validity.typeMismatch)).toBe(true);

    await email.fill('playwright-error@example.invalid');
    const simulate = async (status, message) => {
        await page.route('**/api/auth/login', (route) => route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, error: true, code: `SIMULATED_${status}`, message })
        }));
        const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login');
        await submit.click();
        const response = await responsePromise;
        expect(response.status()).toBe(status);
        await expect(page.getByRole('alert')).toContainText(status >= 500 ? 'temporarily unavailable' : message);
        await page.unroute('**/api/auth/login');
    };

    await simulate(403, 'This request origin is not allowed.');
    await simulate(404, 'The account route was not found.');
    await simulate(500, 'Your saved data is temporarily unavailable.');

    await page.route('**/api/auth/login', (route) => route.abort('failed'));
    await submit.click();
    await expect(page.getByRole('alert')).toContainText('Unable to connect to the server');
    await page.unroute('**/api/auth/login');

    await page.route('**/api/auth/login', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' }) });
    });
    const slowResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login');
    await submit.click();
    await expect(submit).toHaveText('Please wait...');
    await expect(submit).toBeDisabled();
    expect((await slowResponse).status()).toBe(401);
    await page.unroute('**/api/auth/login');
    await expect(page.getByRole('alert')).toContainText('incorrect');
});

test('@desktop successful signup returns to login with a clear confirmation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.getByLabel('Full name').fill('Signup Flow Candidate');
    await page.getByLabel('Email address').fill('signup-flow@example.test');
    await page.getByLabel('Password').fill('signup-flow-test-password');
    await page.route('**/api/auth/signup', (route) => route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, code: 'SIGNUP_ACCEPTED', message: 'Signup request complete. Please sign in to continue. If you already have an account, use your existing password.' })
    }));

    await page.locator('form').getByRole('button', { name: 'Create account', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Please sign in to continue');
    await expect(page.getByLabel('Email address')).toHaveValue('signup-flow@example.test');
});