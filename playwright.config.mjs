import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'playwright/test';

const baseURL = process.env.BASE_URL || 'http://localhost:8812';
const base = new URL(baseURL);
const isLocal = ['localhost', '127.0.0.1'].includes(base.hostname);
const shouldStartServer = isLocal && process.env.PLAYWRIGHT_START_SERVER !== '0';
const port = process.env.E2E_PORT || base.port || '8812';
const simulationFrontendOrigin = process.env.E2E_FRONTEND_ORIGIN || 'https://playwright-simulation.example.invalid';
const allowedOrigins = [...new Set([
    ...String(process.env.FRONTEND_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
    base.origin
])].join(',');
const outputRoot = path.join(os.tmpdir(), 'ts-police-ai-playwright');

export default defineConfig({
    testDir: './e2e',
    testMatch: '**/*.spec.mjs',
    fullyParallel: false,
    workers: 1,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    timeout: 240_000,
    expect: { timeout: 15_000 },
    outputDir: path.join(outputRoot, 'results'),
    reporter: [
        ['list'],
        ['html', { outputFolder: path.join(outputRoot, 'report'), open: 'never' }]
    ],
    use: {
        baseURL,
        headless: true,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'off',
        actionTimeout: 15_000,
        navigationTimeout: 30_000
    },
    projects: [
        {
            name: 'chromium-desktop',
            grep: /@desktop/,
            use: { browserName: 'chromium', viewport: { width: 1365, height: 900 }, trace: 'off' }
        },
        {
            name: 'chromium-mobile',
            grep: /@mobile/,
            use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
        },
        {
            name: 'chromium-tablet',
            grep: /@tablet/,
            use: { browserName: 'chromium', viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true }
        }
    ],
    ...(shouldStartServer ? {
        webServer: {
            command: 'node server/index.mjs',
            url: `${baseURL}/api/health`,
            reuseExistingServer: false,
            timeout: 120_000,
            stdout: 'ignore',
            stderr: 'pipe',
            env: {
                ...process.env,
                NODE_ENV: 'production',
                RENDER: 'true',
                PORT: String(port),
                FRONTEND_URL: simulationFrontendOrigin,
                FRONTEND_ORIGINS: allowedOrigins,
                GOOGLE_REDIRECT_URI: process.env.E2E_GOOGLE_REDIRECT_URI || `${simulationFrontendOrigin}/api/drive/oauth2callback`
            }
        }
    } : {})
});