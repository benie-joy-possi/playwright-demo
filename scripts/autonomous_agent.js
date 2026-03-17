const { chromium } = require('playwright');
const axios = require('axios');
const path = require('path');

/**
 * Autonomous QA Agent for Playwright
 * Drives browser interactions using LLM tool-calling.
 */

const MODEL = process.env.LLM_MODEL || 'glm-5';
const API_KEY = process.env.LLM_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';

if (!API_KEY) {
    console.error('Error: LLM_API_KEY is not defined.');
    process.exit(1);
}

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'click',
            description: 'Clicks an element on the page using a CSS selector or text.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'The CSS selector or "text=..."' }
                },
                required: ['selector']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fill',
            description: 'Fills an input field with text.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'The CSS selector' },
                    text: { type: 'string', description: 'The text to enter' }
                },
                required: ['selector', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'wait',
            description: 'Waits for a specific time or element.',
            parameters: {
                type: 'object',
                properties: {
                    ms: { type: 'integer', description: 'Milliseconds to wait' },
                    selector: { type: 'string', description: 'Optional selector to wait for' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'finish_test',
            description: 'Declares the test as finished with a final verdict.',
            parameters: {
                type: 'object',
                properties: {
                    verdict: { type: 'string', enum: ['SUCCESS', 'FAILURE'] },
                    comment: { type: 'string', description: 'Summary of the test run' }
                },
                required: ['verdict', 'comment']
            }
        }
    }
];

async function callLLM(messages) {
    const response = await axios.post(`${BASE_URL}/chat/completions`, {
        model: MODEL,
        messages: messages,
        tools: TOOLS,
        tool_choice: 'auto'
    }, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    return response.data.choices[0].message;
}

async function runAutonomousAgent() {
    console.log(`Starting Autonomous Agent [Model: ${MODEL}]`);

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const indexPath = `file://${path.resolve(__dirname, '../index.html')}`;

    await page.goto(indexPath);

    let messages = [
        {
            role: 'system',
            content: `You are an autonomous QA engineer. Your goal is to test the web application at the provided URL.
Observe the page state, interact with elements, and verify that the core flows (Login, Inventory, Cart, Checkout) work as expected.
When you are satisfied or found a critical bug, use the 'finish_test' tool.
Instructions:
- Use 'tester' as username and 'password123' as password.
- You must verify that you can add items and complete checkout.
- Provide a clear verdict at the end.`
        }
    ];

    let step = 0;
    let finished = false;

    while (!finished && step < 15) {
        step++;
        console.log(`\n--- Step ${step} ---`);

        // Observe State
        const url = page.url();
        const ax = await page.accessibility.snapshot();
        const stateDesc = `Current URL: ${url}\nAccessibility Tree: ${JSON.stringify(ax, null, 2)}`;

        messages.push({ role: 'user', content: stateDesc });

        try {
            const aiMessage = await callLLM(messages);
            messages.push(aiMessage);

            if (aiMessage.tool_calls) {
                for (const toolCall of aiMessage.tool_calls) {
                    const { name, arguments: argsJson } = toolCall.function;
                    const args = JSON.parse(argsJson);
                    console.log(`Executing Action: ${name}`, args);

                    let result = '';
                    if (name === 'click') {
                        await page.click(args.selector);
                        result = `Successfully clicked ${args.selector}`;
                    } else if (name === 'fill') {
                        await page.fill(args.selector, args.text);
                        result = `Filled ${args.selector} with ${args.text}`;
                    } else if (name === 'wait') {
                        if (args.ms) await page.waitForTimeout(args.ms);
                        if (args.selector) await page.waitForSelector(args.selector);
                        result = 'Wait completed';
                    } else if (name === 'finish_test') {
                        console.log(`TEST FINISHED [${args.verdict}]: ${args.comment}`);

                        // Capture final evidence
                        const screenshotPath = path.resolve(__dirname, '../screenshots/final_verdict.png');
                        await page.screenshot({ path: screenshotPath });
                        console.log(`Final evidence captured at: ${screenshotPath}`);

                        finished = true;
                        result = 'Test finished successfully. Final screenshot taken.';

                        // Post findings if on GitHub
                        if (process.env.PAT_TOKEN && process.env.PR_NUMBER) {
                            const repo = process.env.GITHUB_REPOSITORY;
                            const prNumber = process.env.PR_NUMBER;
                            const commentBody = `### 🤖 Autonomous Agent Review\n**Verdict: ${args.verdict}**\n\n${args.comment}\n\n*Final screenshot captured in artifacts.*`;

                            await axios.post(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
                                body: commentBody
                            }, {
                                headers: {
                                    'Authorization': `token ${process.env.PAT_TOKEN}`,
                                    'Accept': 'application/vnd.github.v3+json'
                                }
                            });
                        }
                    }

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        name: name,
                        content: result
                    });
                }
            } else {
                console.log('AI Response:', aiMessage.content);
                messages.push({ role: 'user', content: 'Please proceed with an action or finish the test.' });
            }
        } catch (error) {
            console.error('Agent Error:', error.message);
            break;
        }
    }

    if (!finished) console.log('Agent timed out after 15 steps.');

    await browser.close();
}

runAutonomousAgent().catch(console.error);
