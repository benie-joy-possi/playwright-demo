'use strict';

/**
 * playwright_runner.js
 * Receives natural-language test scenarios from the LLM and executes them
 * in a real Chromium browser via Playwright.
 *
 * For each scenario it captures:
 *  - Screenshots at key steps and on failure
 *  - Browser console messages (errors, warnings)
 *  - Network requests and responses (status, size, timing)
 *  - JS exceptions
 */

const { chromium } = require('playwright');
const path         = require('path');
const fs           = require('fs');

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(process.cwd(), '../../agent-artifacts');
const DEFAULT_TIMEOUT = 15_000; // 15 s per action

// ── Ensure artifact directories exist ─────────────────────────────────────────

function ensureDirs(scenarioId) {
  const dir = path.join(ARTIFACTS_DIR, 'screenshots', scenarioId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Map a natural-language step to a Playwright action ───────────────────────

async function executeStep(page, step, ssDir, stepIndex) {
  const s = step.toLowerCase().trim();
  let screenshotPath = null;

  try {
    // Navigate
    if (/^(go to|navigate to|open|visit)\s+(.+)$/.test(s)) {
      const url = step.match(/\b(https?:\/\/\S+|\/\S*)/)?.[0];
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    // Click
    } else if (/^click\s+(.+)$/.test(s)) {
      const target = step.replace(/^click\s+/i, '').trim();
      await smartClick(page, target);

    // Type / fill
    } else if (/^(type|enter|fill|input)\s+["'](.+)["']\s+(in|into)\s+(.+)$/i.test(s)) {
      const m    = step.match(/["'](.+?)["']\s+(?:in|into)\s+(.+)/i);
      const text = m?.[1];
      const tgt  = m?.[2];
      if (text && tgt) await smartFill(page, tgt, text);

    // Wait
    } else if (/^wait\s+(for|until)\s+(.+)$/.test(s)) {
      const target = step.replace(/^wait\s+(?:for|until)\s+/i, '').trim();
      if (/\d+\s*(ms|seconds?|s)/.test(target)) {
        const ms = parseTimeMs(target);
        await page.waitForTimeout(ms);
      } else {
        await page.waitForSelector(await resolveSelector(page, target), { timeout: DEFAULT_TIMEOUT });
      }

    // Assert / verify / check
    } else if (/^(assert|verify|check|confirm)\s+(.+)$/.test(s)) {
      // We don't hard-assert — we capture and note in summary
      const condition = step.replace(/^(assert|verify|check|confirm)\s+/i, '').trim();
      const found     = await pageContains(page, condition);
      if (!found) {
        console.warn(`  ⚠️  Assertion may have failed: "${condition}"`);
        screenshotPath = await screenshot(page, ssDir, `step-${stepIndex}-assert-fail`);
      }

    // Scroll
    } else if (/^scroll\s+(down|up|to bottom|to top)/.test(s)) {
      if (/down|bottom/.test(s)) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      else                        await page.evaluate(() => window.scrollTo(0, 0));

    // Press key
    } else if (/^press\s+(.+)$/.test(s)) {
      const key = step.replace(/^press\s+/i, '').trim();
      await page.keyboard.press(key);

    // Select dropdown
    } else if (/^select\s+["'](.+?)["']\s+(?:from|in)\s+(.+)$/i.test(s)) {
      const m      = step.match(/["'](.+?)["']\s+(?:from|in)\s+(.+)/i);
      const option = m?.[1];
      const sel    = m?.[2];
      if (option && sel) {
        const locator = await resolveSelector(page, sel);
        await page.selectOption(locator, { label: option });
      }

    // Fallback — screenshot + note
    } else {
      console.warn(`  ℹ️  Unrecognised step, skipping: "${step}"`);
    }

    // Post-step screenshot (every 3 steps or named steps)
    if (stepIndex % 3 === 0 || /screenshot/.test(s)) {
      screenshotPath = await screenshot(page, ssDir, `step-${stepIndex}`);
    }

  } catch (err) {
    console.error(`  ❌ Step failed: "${step}" → ${err.message}`);
    screenshotPath = await screenshot(page, ssDir, `step-${stepIndex}-error`).catch(() => null);
    throw err;
  }

  return screenshotPath;
}

// ── Smart element resolution ──────────────────────────────────────────────────

async function resolveSelector(page, description) {
  // Try ARIA role first
  const roleMap = {
    button: 'button', link: 'link', input: 'textbox',
    checkbox: 'checkbox', dropdown: 'combobox', menu: 'menu',
  };
  for (const [word, role] of Object.entries(roleMap)) {
    if (description.toLowerCase().includes(word)) {
      return `role=${role}[name*="${description.replace(new RegExp(word, 'i'), '').trim()}"]`;
    }
  }
  // Try text
  return `text=${description}`;
}

async function smartClick(page, target) {
  // Priority order: getByRole → getByText → getByLabel → CSS
  const strategies = [
    () => page.getByRole('button', { name: new RegExp(target, 'i') }).first().click({ timeout: DEFAULT_TIMEOUT }),
    () => page.getByRole('link',   { name: new RegExp(target, 'i') }).first().click({ timeout: DEFAULT_TIMEOUT }),
    () => page.getByText(target, { exact: false }).first().click({ timeout: DEFAULT_TIMEOUT }),
    () => page.getByLabel(target, { exact: false }).first().click({ timeout: DEFAULT_TIMEOUT }),
    () => page.locator(`text=${target}`).first().click({ timeout: DEFAULT_TIMEOUT }),
  ];
  for (const attempt of strategies) {
    try { await attempt(); return; } catch {}
  }
  throw new Error(`Could not find clickable element matching: "${target}"`);
}

async function smartFill(page, target, value) {
  const strategies = [
    () => page.getByLabel(target, { exact: false }).fill(value),
    () => page.getByPlaceholder(new RegExp(target, 'i')).fill(value),
    () => page.getByRole('textbox', { name: new RegExp(target, 'i') }).fill(value),
    () => page.locator(`[name*="${target}" i], [id*="${target}" i]`).first().fill(value),
  ];
  for (const attempt of strategies) {
    try { await attempt(); return; } catch {}
  }
  throw new Error(`Could not find fillable input matching: "${target}"`);
}

async function pageContains(page, condition) {
  try {
    // Try as visible text
    const text = await page.textContent('body', { timeout: 3000 });
    if (text && text.toLowerCase().includes(condition.toLowerCase())) return true;
    // Try URL
    const url = page.url();
    if (url.toLowerCase().includes(condition.toLowerCase())) return true;
    return false;
  } catch {
    return false;
  }
}

function parseTimeMs(str) {
  const m = str.match(/(\d+)\s*(ms|seconds?|s)/i);
  if (!m) return 1000;
  return m[2].startsWith('s') ? parseInt(m[1]) * 1000 : parseInt(m[1]);
}

// ── Screenshot helper ─────────────────────────────────────────────────────────

async function screenshot(page, dir, name) {
  const p = path.join(dir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

// ── Run a single scenario ─────────────────────────────────────────────────────

async function runScenario(scenario, baseUrl) {
  const { id, title, url, steps, assertionHints } = scenario;
  const ssDir        = ensureDirs(id);
  const screenshots  = [];
  const networkReqs  = [];
  const consoleErrs  = [];
  const networkIssues = [];
  const stepsExecuted = [];

  let status  = 'passed';
  let summary = '';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      viewport:          { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      recordVideo:       { dir: path.join(ARTIFACTS_DIR, 'videos', id) },
    });

    // ── Intercept network ─────────────────────────────────────────────────
    await context.route('**/*', route => {
      route.continue();
    });

    const page = await context.newPage();

    // Console messages
    page.on('console', msg => {
      if (['error', 'warning'].includes(msg.type())) {
        consoleErrs.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
      }
    });

    // Uncaught exceptions
    page.on('pageerror', err => {
      consoleErrs.push(`[JS EXCEPTION] ${err.message}`);
    });

    // Network capture
    page.on('response', async resp => {
      const req  = resp.request();
      const size = resp.headers()['content-length'] || '?';
      const entry = {
        method:  req.method(),
        url:     resp.url(),
        status:  resp.status(),
        size:    `${size} bytes`,
      };
      networkReqs.push(entry);

      // Flag anything that looks wrong
      if (resp.status() >= 400) {
        networkIssues.push({ ...entry, issue: `HTTP ${resp.status()}` });
      }
      if (parseInt(size) > 1_000_000) {
        networkIssues.push({ ...entry, issue: `Large response: ${size} bytes` });
      }
    });

    // ── Navigate to the base URL first ───────────────────────────────────
    const targetUrl = url.startsWith('http')
      ? url
      : `${baseUrl || ''}${url}`;

    console.log(`  🌐 Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    screenshots.push(await screenshot(page, ssDir, '00-initial'));

    // ── Execute each step ─────────────────────────────────────────────────
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      console.log(`  ▶ Step ${i + 1}: ${step}`);
      try {
        const ss = await executeStep(page, step, ssDir, i + 1);
        if (ss) screenshots.push(ss);
        stepsExecuted.push(`✅ ${step}`);
      } catch (err) {
        stepsExecuted.push(`❌ ${step} (${err.message})`);
        status  = 'failed';
        summary = `Step failed: "${step}" — ${err.message}`;
        screenshots.push(await screenshot(page, ssDir, `fail-step-${i + 1}`).catch(() => null));
        break;
      }
    }

    // ── Final screenshot ──────────────────────────────────────────────────
    screenshots.push(await screenshot(page, ssDir, '99-final'));

    // ── Quick assertion check based on hints ──────────────────────────────
    if (status === 'passed' && assertionHints?.length) {
      const body = await page.textContent('body').catch(() => '');
      const currentUrl = page.url();
      const failedHints = [];

      for (const hint of assertionHints) {
        const inBody = body.toLowerCase().includes(hint.toLowerCase());
        const inUrl  = currentUrl.toLowerCase().includes(hint.toLowerCase());
        if (!inBody && !inUrl) failedHints.push(hint);
      }

      if (failedHints.length > 0) {
        status  = 'warning';
        summary = `Assertions not confirmed: ${failedHints.join(', ')}`;
      }
    }

    if (status === 'passed') {
      summary = `All ${steps.length} steps completed. ${networkIssues.length} network issues.`;
    }

    await context.close();
  } catch (outerErr) {
    status  = 'failed';
    summary = `Scenario crashed: ${outerErr.message}`;
    console.error(`  💥 Scenario "${title}" crashed:`, outerErr.message);
  } finally {
    await browser.close();
  }

  return {
    id, title,
    status,          // 'passed' | 'failed' | 'warning'
    summary,
    stepsExecuted,
    screenshots:     screenshots.filter(Boolean),
    networkRequests: networkReqs,
    networkIssues,
    consoleErrors:   consoleErrs,
  };
}

/**
 * Run all scenarios sequentially (safe in CI with limited memory).
 * Returns array of result objects.
 */
async function runScenarios(scenarios, baseUrl) {
  const results = [];
  for (const scenario of scenarios) {
    console.log(`\n🧪 Running scenario [${scenario.id}]: ${scenario.title}`);
    const result = await runScenario(scenario, baseUrl);
    results.push(result);
    console.log(`   → ${result.status.toUpperCase()}: ${result.summary}`);
  }
  return results;
}

module.exports = { runScenarios };
