import { expect, test } from 'playwright/test';

test('@desktop @mobile @tablet YouTube study explorer filters, watch later, playback, and responsive layout', async ({ page, context }) => {
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
        requests.push({
            query,
            pageToken,
            duration: url.searchParams.get('duration'),
            order: url.searchParams.get('order'),
            language: url.searchParams.get('language')
        });
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
                videos: secondPage ? [{
                    videoId: 'zyxwvutsrq0',
                    channelId: 'UC-example-study',
                    title: `${query} video part two`,
                    thumbnailUrl: 'https://i.ytimg.com/vi/zyxwvutsrq0/hqdefault.jpg',
                    channelName: 'Example study channel',
                    description: `A second video about ${query}.`,
                    publishedAt: '2026-01-02T03:04:05Z',
                    durationSeconds: 252
                }] : [{
                    videoId: 'abcdefghijk',
                    channelId: 'UC-example-study',
                    title: `${query} video`,
                    thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
                    channelName: 'Example study channel',
                    description: `A video about ${query}.`,
                    publishedAt: '2026-01-02T03:04:05Z',
                    durationSeconds: 225
                }, {
                    videoId: 'lmnopqrstuv',
                    channelId: 'UC-second-study',
                    title: `${query} alternate video`,
                    thumbnailUrl: 'https://i.ytimg.com/vi/lmnopqrstuv/hqdefault.jpg',
                    channelName: 'Second study channel',
                    description: `Another video about ${query}.`,
                    publishedAt: '2026-02-02T03:04:05Z',
                    durationSeconds: 1234
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
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Browse YouTube videos' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Browse YouTube videos' })).toHaveCount(0);
    const search = page.getByRole('searchbox', { name: 'Search YouTube videos' });
    await page.goto('/?youtube=Percentages');
    await expect(page).toHaveURL(/\/\?youtube=Percentages$/);
    await expect(page.getByRole('heading', { name: 'Explore YouTube' })).toBeVisible();
    await expect(search).toHaveValue('Percentages');
    await expect(page.getByRole('button', { name: 'Play Percentages video by Example study channel' })).toBeVisible();
    await expect(page.getByText('Education category', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Video language')).toHaveValue('all');
    expect(requests.filter((request) => request.query === 'Percentages' && !request.pageToken)).toHaveLength(1);

    for (const phrase of ['React tutorials', 'Python tutorials', 'arbitrary keywords']) {
        const requestCountBeforeTyping = requests.length;
        await search.fill(phrase);
        expect(requests).toHaveLength(requestCountBeforeTyping);
        await page.getByRole('button', { name: 'Search videos' }).click();
        await expect(page.getByRole('button', { name: `Play ${phrase} video by Example study channel` })).toBeVisible();
        expect(requests.some((request) => request.query === phrase && !request.pageToken)).toBe(true);
    }

    await search.fill('React tutorials');
    expect(requests.filter((request) => request.query === 'React tutorials' && !request.pageToken)).toHaveLength(1);
    await page.getByRole('button', { name: 'Search videos' }).click();
    const firstVideo = page.getByRole('button', { name: 'Play React tutorials video by Example study channel' });
    await expect(firstVideo).toBeVisible();
    await expect(firstVideo.locator('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
    await expect(firstVideo).toContainText('A video about React tutorials.');
    await expect(firstVideo).toContainText('2026');
    await expect(firstVideo).toContainText('3:45');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('button', { name: 'Play React tutorials video part two by Example study channel' })).toBeVisible();
    expect(requests.some((request) => request.query === 'React tutorials' && request.pageToken === 'next-page')).toBe(true);

    await firstVideo.click();
    const player = page.getByRole('dialog');
    await expect(player).toBeVisible();
    const previousVideoButton = page.getByRole('button', { name: 'Previous video' });
    const nextVideoButton = page.getByRole('button', { name: 'Next video' });
    await expect(previousVideoButton).toBeDisabled();
    await expect(nextVideoButton).toBeEnabled();
    const iframe = player.locator('iframe');
    await expect(iframe).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/abcdefghijk/);
    await expect(iframe).toHaveAttribute('allowfullscreen', '');
    await expect(iframe).toHaveAttribute('allow', /autoplay.*picture-in-picture/);
    await expect(page).toHaveURL(/\/\?youtube=Percentages$/);
    await expect(page.locator('a[href*="youtube.com"]')).toHaveCount(0);
    expect(context.pages()).toHaveLength(1);
    await nextVideoButton.click();
    await expect(iframe).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/lmnopqrstuv/);
    await nextVideoButton.click();
    await expect(iframe).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/zyxwvutsrq0/);
    await expect(previousVideoButton).toBeEnabled();
    await expect(nextVideoButton).toBeDisabled();
    await previousVideoButton.click();
    await expect(iframe).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/lmnopqrstuv/);
    await previousVideoButton.click();
    await expect(iframe).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/abcdefghijk/);

    await page.getByRole('button', { name: 'Float video player' }).click();
    await expect(player).toHaveAttribute('aria-modal', 'false');
    const requestsBeforeBrowsingWithFloatingPlayer = requests.length;
    await search.fill('Keep studying');
    expect(requests).toHaveLength(requestsBeforeBrowsingWithFloatingPlayer);
    await search.fill('React tutorials');
    await expect(page.getByRole('button', { name: 'Dock video player' })).toBeVisible();
    await nextVideoButton.click();
    await expect(iframe).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/lmnopqrstuv/);
    await nextVideoButton.click();
    await expect(iframe).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/zyxwvutsrq0/);
    await page.getByRole('button', { name: 'Dock video player' }).click();
    await expect(player).toHaveAttribute('aria-modal', 'true');
    await player.getByRole('button', { name: 'Close video player' }).click();
    await expect(player).toHaveCount(0);
    await firstVideo.click();
    await expect(player).toHaveAttribute('aria-modal', 'true');
    await player.getByRole('button', { name: 'Close video player' }).click();
    await expect(player).toHaveCount(0);

    await page.getByLabel('Video length').selectOption('short');
    await page.getByLabel('Sort videos').selectOption('date');
    const requestCountBeforeDurationSearch = requests.length;
    await search.fill('duration test');
    expect(requests).toHaveLength(requestCountBeforeDurationSearch);
    await page.getByRole('button', { name: 'Search videos' }).click();
    await expect(page.getByRole('button', { name: 'Play duration test video by Example study channel' })).toBeVisible();
    expect(requests.at(-1)).toMatchObject({ query: 'duration test', duration: 'short', order: 'date' });

    await page.getByLabel('Filter by channel').selectOption('UC-second-study');
    await expect(page.getByRole('button', { name: 'Play duration test alternate video by Second study channel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play duration test video by Example study channel' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Watch later', exact: true }).click();
    await expect(page.getByRole('button', { name: /Watch Later 1/ })).toBeVisible();
    await page.getByRole('button', { name: /Watch Later/ }).click();
    await expect(page.getByRole('button', { name: 'Play duration test alternate video by Second study channel' })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: /Watch Later/ }).click();
    await expect(page.getByRole('button', { name: 'Play duration test alternate video by Second study channel' })).toBeVisible();
    await page.getByRole('button', { name: 'Saved for later' }).click();
    await expect(page.getByText('Your Watch Later list is empty')).toBeVisible();
    await page.getByRole('button', { name: 'Search results' }).click();

    for (const [value, query] of [
        ['te', 'Telugu language test'],
        ['hi', 'Hindi language test'],
        ['en', 'English language test'],
        ['all', 'All languages test']
    ]) {
        await page.getByLabel('Video language').selectOption(value);
        const requestCountBeforeLanguageSearch = requests.length;
        await search.fill(query);
        expect(requests).toHaveLength(requestCountBeforeLanguageSearch);
        await page.getByRole('button', { name: 'Search videos' }).click();
        await expect(page.getByRole('button', { name: `Play ${query} video by Example study channel` })).toBeVisible();
        expect(requests.at(-1)).toMatchObject({
            query,
            language: value === 'all' ? null : value
        });
        if (value === 'te') {
            await page.getByRole('button', { name: 'Load more' }).click();
            await expect(page.getByRole('button', { name: `Play ${query} video part two by Example study channel` })).toBeVisible();
            expect(requests.at(-1)).toMatchObject({ query, pageToken: 'next-page', language: 'te' });
        }
    }

    const requestCountBeforeRelatedSearch = requests.length;
    await page.getByRole('button', { name: 'Telangana GK', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play Telangana GK video by Example study channel' })).toBeVisible();
    expect(requests).toHaveLength(requestCountBeforeRelatedSearch + 1);

    await search.fill('quota test');
    expect(requests.some((request) => request.query === 'quota test')).toBe(false);
    await page.getByRole('button', { name: 'Search videos' }).click();
    await expect(page.getByRole('alert')).toContainText('API quota');
    await expect(page).toHaveURL(/\/\?youtube=Percentages$/);
    expect(context.pages()).toHaveLength(1);

    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hasHorizontalOverflow).toBe(false);
});
