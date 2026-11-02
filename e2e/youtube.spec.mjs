import { expect, test } from 'playwright/test';

test('@desktop @mobile @tablet YouTube search, pagination, playback, quota errors, and responsive layout', async ({ page, context }) => {
    const requests = [];
    await page.route('**/api/auth/me', (route) => route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 'AUTH_REQUIRED', message: 'Sign in required.' })
    }));
    await page.route('**/api/youtube/search?*', async (route) => {
        const url = new URL(route.request().url());
        const query = url.searchParams.get('q');
        const pageToken = url.searchParams.get('pageToken');
        requests.push({ query, pageToken });
        if (query === 'quota test') {
            await route.fulfill({
                status: 429,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: false,
                    code: 'YOUTUBE_QUOTA_EXCEEDED',
                    message: 'YouTube search has reached its API quota. Please try again later.'
                })
            });
            return;
        }

        const secondPage = pageToken === 'next-page';
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                nextPageToken: secondPage ? '' : 'next-page',
                videos: [{
                    videoId: secondPage ? 'lmnopqrstuv' : 'abcdefghijk',
                    title: `${query} video${secondPage ? ' part two' : ''}`,
                    thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
                    channelName: 'Example channel',
                    description: `A video about ${query}.`,
                    publishedAt: '2026-01-02T03:04:05Z'
                }]
            })
        });
    });
    await page.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Embedded player test</title>'
    }));

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Browse YouTube videos' })).toBeVisible();
    await page.getByRole('button', { name: 'Browse YouTube videos' }).click();
    await expect(page).toHaveURL(/\/youtube$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Explore YouTube' })).toBeVisible();
    await expect(page.getByText('What would you like to watch?')).toBeVisible();

    const search = page.getByRole('searchbox', { name: 'Search YouTube videos' });
    for (const phrase of ['React tutorials', 'Python tutorials', 'arbitrary keywords']) {
        await search.fill(phrase);
        await expect(page.getByRole('button', { name: `Play ${phrase} video by Example channel` })).toBeVisible();
        expect(requests.some((request) => request.query === phrase && !request.pageToken)).toBe(true);
    }

    await search.fill('React tutorials');
    const firstVideo = page.getByRole('button', { name: 'Play React tutorials video by Example channel' });
    await expect(firstVideo).toBeVisible();
    await expect(firstVideo.locator('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
    await expect(firstVideo).toContainText('A video about React tutorials.');
    await expect(firstVideo).toContainText('2026');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('button', { name: 'Play React tutorials video part two by Example channel' })).toBeVisible();
    expect(requests.some((request) => request.query === 'React tutorials' && request.pageToken === 'next-page')).toBe(true);

    await firstVideo.click();
    const player = page.getByRole('dialog');
    await expect(player).toBeVisible();
    const iframe = player.locator('iframe');
    await expect(iframe).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/abcdefghijk/);
    await expect(iframe).toHaveAttribute('allowfullscreen', '');
    await expect(iframe).toHaveAttribute('allow', /autoplay.*picture-in-picture/);
    await expect(page).toHaveURL(/\/youtube$/);
    await expect(page.locator('a[href*="youtube.com"]')).toHaveCount(0);
    expect(context.pages()).toHaveLength(1);
    await page.getByRole('button', { name: 'Close video player' }).last().click();
    await expect(player).toHaveCount(0);

    await search.fill('quota test');
    await expect(page.getByRole('alert')).toContainText('API quota');
    await expect(page).toHaveURL(/\/youtube$/);
    expect(context.pages()).toHaveLength(1);

    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hasHorizontalOverflow).toBe(false);
});
