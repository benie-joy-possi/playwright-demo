const { chromium } = require('playwright');
const axios = require('axios');
const path = require('path');

async function runAgenticReview() {
    console.log('--- Starting Deep Agentic QA Review ---');
    console.log(`Using Model: ${process.env.LLM_MODEL}`);

    const browser = await chromium.launch();
    const page = await browser.newPage();

    let stepLogs = [];

    try {
        const indexPath = `file://${path.resolve(__dirname, '../index.html')}`;
        await page.goto(indexPath);
        stepLogs.push("Navigate to App: ✅");

        // 1. Login
        await page.fill('#username', 'tester');
        await page.fill('#password', 'password123');
        await page.click('#login-btn');
        await page.waitForSelector('#inventory-page.active');
        stepLogs.push("Login Flow: ✅");

        // 2. Inventory & Cart
        await page.click('text=Add >> nth=0'); // Add Helmet
        await page.click('text=Add >> nth=1'); // Add Boots
        const cartCount = await page.innerText('#cart-count');
        if (cartCount === '2') {
            stepLogs.push("Add to Cart (2 items): ✅");
        } else {
            throw new Error(`Cart count mismatch: expected 2, got ${cartCount}`);
        }

        // 3. Checkout
        await page.click('text=Go to Checkout');
        await page.waitForSelector('#checkout-page.active');
        stepLogs.push("Navigate to Checkout: ✅");

        await page.click('#finish-btn');
        await page.waitForSelector('.success');
        stepLogs.push("Final Order Confirmation: ✅");

        // Evidence
        const screenshotPath = path.resolve(__dirname, '../screenshots/full_flow_success.png');
        await page.screenshot({ path: screenshotPath });

        const reviewComment = `
### 🤖 Deep Agentic QA Review Result

I have performed a multi-step functional review of the updated application.

**Functional Verification:**
${stepLogs.map(log => `- ${log}`).join('\n')}

**Test Coverage:**
- Authentication Check
- Inventory Interaction
- State Management (Cart Count)
- Multi-page Navigation
- Final Transaction Flow

**Verdict:** 🚀 Ready for Deployment. All complex flows are functional.
`;
        console.log(reviewComment);

        if (process.env.PAT_TOKEN && process.env.PR_NUMBER) {
            const repo = process.env.GITHUB_REPOSITORY;
            const prNumber = process.env.PR_NUMBER;
            const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;

            await axios.post(url, { body: reviewComment }, {
                headers: {
                    'Authorization': `token ${process.env.PAT_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            console.log('Comment posted successfully!');
        }

    } catch (error) {
        console.error('Agentic Review Failed:', error);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

runAgenticReview();
