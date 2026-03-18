'use strict';

/**
 * llm_client.js
 * Wraps the Qwen API (OpenAI-compatible) for both text and vision calls.
 * Qwen-coder-plus  → code analysis, test scenario generation
 * Qwen-vl-plus     → screenshot interpretation
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const client = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL || 'https://api.ai.camer.digital/v1',
});

const TEXT_MODEL = process.env.LLM_MODEL || 'gemini-2.5-flash';
const VISION_MODEL = process.env.LLM_VL_MODEL || 'gemini-2.5-flash';

console.log(`🤖 LLM CONFIG: Model=${TEXT_MODEL}, Vision=${VISION_MODEL}, BaseURL=${client.baseURL}`);

// ── Low-level chat helpers ────────────────────────────────────────────────────

async function chat(messages, { model = TEXT_MODEL, temperature = 0.2, maxTokens = 4096 } = {}) {
  try {
    const resp = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
    return resp.choices[0].message.content;
  } catch (err) {
    console.error(`❌ LLM Call Failed [Model: ${model}]: ${err.message}`);
    if (err.status === 404) {
      console.error(`💡 Tip: Check if the model "${model}" is supported by your endpoint: ${client.baseURL}`);
    }
    throw err;
  }
}

async function chatWithImages(messages, { temperature = 0.3, maxTokens = 4096 } = {}) {
  return chat(messages, { model: VISION_MODEL, temperature, maxTokens });
}

// ── Encode a screenshot file to base64 data URL ───────────────────────────────

function encodeImage(imagePath) {
  const data = fs.readFileSync(imagePath);
  return `data:image/png;base64,${data.toString('base64')}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Given the PR metadata and diff, ask Qwen to generate a structured list
 * of Playwright test scenarios to run against the deployed/local app.
 *
 * Returns: Array<{
 *   id:            string
 *   title:         string
 *   description:   string
 *   url:           string        — path relative to APP_BASE_URL or absolute
 *   steps:         string[]      — natural language steps
 *   assertionHints: string[]     — what "pass" looks like
 *   priority:      'high'|'medium'|'low'
 * }>
 */
async function generateTestScenarios(prData) {
  const { title, description, diff, changedFiles, baseUrl } = prData;
  const max = parseInt(process.env.MAX_SCENARIOS || '5', 10);

  const systemPrompt = `You are a senior QA engineer. Your job is to read a GitHub pull request
and decide which UI/browser test scenarios are most valuable to run given the changes.

You MUST respond with ONLY valid JSON — no explanation, no markdown fences.
The JSON must be an array of up to ${max} test scenario objects.

Each object has exactly these keys:
  id             (string, e.g. "TC-01")
  title          (string, short human label)
  description    (string, one sentence)
  url            (string, the path or full URL to test; use relative paths like "/login")
  steps          (array of strings, ordered natural-language instructions for a browser agent)
  assertionHints (array of strings, what a passing result looks like)
  priority       ("high" | "medium" | "low")

Rules:
- Focus on paths/features actually touched by the diff.
- Prefer user-visible flows over internal implementation details.
- If the PR description mentions a bug fix, include a regression test for it.
- steps must be concrete enough for a Playwright automation agent to execute.
- Keep assertionHints specific: use visible text, URLs, element states.
- If no base URL is available or the app cannot be browsed, return an empty array [].`;

  const userPrompt = `PR TITLE: ${title}

PR DESCRIPTION:
${description || '(none)'}

BASE URL: ${baseUrl || '(not configured)'}

CHANGED FILES:
${changedFiles.slice(0, 40).join('\n')}

DIFF (first 8000 chars):
${diff.slice(0, 8000)}`;

  const raw = await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], { temperature: 0.1 });

  try {
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    console.error('Failed to parse test scenarios JSON:\n', raw);
    return [];
  }
}

/**
 * Given PR data + all test results (including screenshot paths),
 * ask Qwen to write a full PR review comment in Markdown.
 *
 * Returns: string (Markdown)
 */
async function generateReviewComment(prData, testResults) {
  const { title, diff, changedFiles } = prData;
  const hasScreenshots = testResults.some(r => r.screenshots?.length > 0);

  // ── Build vision messages if screenshots exist ────────────────────────────
  let screenshotAnalysis = '';
  if (hasScreenshots) {
    const visionMessages = [];
    const imageContents = [];

    for (const result of testResults) {
      if (!result.screenshots?.length) continue;
      imageContents.push({
        type: 'text',
        text: `Test: "${result.title}" — Status: ${result.status}\nSteps executed: ${result.stepsExecuted?.join(' → ') || 'N/A'}`,
      });
      for (const ss of result.screenshots.slice(0, 3)) {
        if (fs.existsSync(ss)) {
          imageContents.push({
            type: 'image_url',
            image_url: { url: encodeImage(ss) },
          });
        }
      }
    }

    if (imageContents.length > 0) {
      const visionResp = await chatWithImages([
        {
          role: 'system',
          content: 'You are a QA engineer analysing browser screenshots from automated tests. Describe what you see: UI state, errors, unexpected behaviour, visual regressions. Be specific. Output plain text.',
        },
        { role: 'user', content: imageContents },
      ]);
      screenshotAnalysis = visionResp;
    }
  }

  // ── Build the review prompt ───────────────────────────────────────────────
  const resultSummary = testResults.map(r =>
    `[${r.status === 'passed' ? '✅' : r.status === 'failed' ? '❌' : '⚠️'}] ${r.title}: ${r.summary}`
  ).join('\n');

  const networkIssues = testResults
    .flatMap(r => r.networkIssues || [])
    .map(n => `- ${n.method} ${n.url} → ${n.status} (${n.size})`)
    .join('\n');

  const consoleErrors = testResults
    .flatMap(r => r.consoleErrors || [])
    .map(e => `- ${e}`)
    .join('\n');

  const systemPrompt = `You are Qwen Code, an AI code reviewer embedded in a GitHub PR workflow.
Write a comprehensive, constructive PR review in Markdown.

Your review MUST follow this exact structure:
1. **## 🤖 Qwen Code Review** (header with PR title)
2. **### 📋 Summary** — 2-3 sentence overview of what the PR does
3. **### 🧪 Automated Test Results** — table + details for each scenario
4. **### 🌐 Network Observations** — any API/network anomalies found
5. **### 🖥️ Visual Findings** — what the screenshots revealed
6. **### 🔍 Code Analysis** — specific observations about the diff
7. **### ✅ Recommendations** — actionable, numbered list
8. **### 📊 Verdict** — one of: APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION

Use GitHub Markdown. Be specific. Reference file names and line numbers when relevant.
Do NOT be generic. Every section must reference evidence from the test results or diff.`;

  const userPrompt = `PR TITLE: ${title}

CHANGED FILES:
${changedFiles.slice(0, 40).join('\n')}

DIFF (first 6000 chars):
${diff.slice(0, 6000)}

AUTOMATED TEST RESULTS:
${resultSummary || '(no tests were run)'}

NETWORK ISSUES DETECTED:
${networkIssues || '(none)'}

CONSOLE ERRORS:
${consoleErrors || '(none)'}

SCREENSHOT ANALYSIS:
${screenshotAnalysis || '(no screenshots available)'}`;

  return chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], { temperature: 0.3, maxTokens: 6000 });
}

module.exports = { generateTestScenarios, generateReviewComment };
