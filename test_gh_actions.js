const { chromium } = require('playwright');

(async () => {
    console.log('Starting Playwright test for GitHub Actions (Standalone Demo)...');
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
        console.log('Navigating to playwright.dev...');
        await page.goto('https://playwright.dev/');

        // Verify title
        const title = await page.title();
        console.log(`Page title: ${title}`);

        if (title.includes('Playwright')) {
            console.log('Assertion Passed: Page title contains "Playwright"');
        } else {
            throw new Error('Assertion Failed: Page title did not contain "Playwright"');
        }

        // Take a screenshot
        const screenshotPath = 'demo_test_success.png';
        await page.screenshot({ path: screenshotPath });
        console.log(`Screenshot saved to ${screenshotPath}`);

    } catch (error) {
        console.error('Test Failed:', error);
        process.exit(1);
    } finally {
        await browser.close();
        console.log('Browser closed. Test finished.');
    }
})();
