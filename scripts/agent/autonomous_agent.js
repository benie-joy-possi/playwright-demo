'use strict';

/**
 * autonomous_agent.js
 * Main entry point for the agentic PR review.
 *
 * Flow:
 *  1. Read context from environment (PR number, base URL, etc.)
 *  2. Acknowledge to GitHub (react, update progress comment)
 *  3. Fetch PR data (diff, files, metadata)
 *  4. Ask LLM to generate test scenarios from the diff
 *  5. Run Playwright on each scenario
 *  6. Ask LLM to generate a review comment from all results
 *  7. Post the review comment and/or formal review to GitHub
 *  8. Update the check run status
 */

const path          = require('path');
const fs            = require('fs');
const github        = require('./github_client');
const llm           = require('./llm_client');
const { runScenarios } = require('./playwright_runner');

// ── Config ────────────────────────────────────────────────────────────────────

const PR_NUMBER     = parseInt(process.env.PR_NUMBER || '0', 10);
const BASE_URL      = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(__dirname, '../../agent-artifacts');
const PROGRESS_ID_FILE = process.env.PROGRESS_COMMENT_ID_FILE || '';

if (!PR_NUMBER) {
  console.error('❌ PR_NUMBER env var is missing.');
  process.exit(1);
}

fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function readProgressCommentId() {
  try { return parseInt(fs.readFileSync(PROGRESS_ID_FILE, 'utf8')); } catch { return null; }
}

async function updateProgress(commentId, text) {
  if (!commentId) return;
  await github.updateComment(commentId, [
    '## 🤖 Qwen Code Review — In Progress',
    '',
    text,
    '',
    `⏱️ ${new Date().toUTCString()}`,
  ].join('\n')).catch(() => {});
}

function buildTestSummaryTable(results) {
  const rows = results.map(r => {
    const icon = r.status === 'passed' ? '✅' : r.status === 'failed' ? '❌' : '⚠️';
    return `| ${icon} | **${r.title}** | ${r.status} | ${r.summary} |`;
  });
  return [
    '| | Scenario | Status | Summary |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function determineReviewEvent(results) {
  if (results.some(r => r.status === 'failed')) return 'REQUEST_CHANGES';
  if (results.some(r => r.status === 'warning')) return 'COMMENT';
  return 'APPROVE';
}

// ── Save results to disk for artifact upload ───────────────────────────────────

function persistResults(prData, scenarios, results, reviewComment) {
  const summary = {
    pr:         { number: prData.number, title: prData.title, author: prData.author },
    scenarios:  scenarios.length,
    results:    results.map(r => ({
      id:       r.id,
      title:    r.title,
      status:   r.status,
      summary:  r.summary,
      networkIssuesCount: r.networkIssues?.length || 0,
      consoleErrorsCount: r.consoleErrors?.length || 0,
      screenshots:        r.screenshots?.length || 0,
    })),
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'review_comment.md'), reviewComment);

  // Write network logs per scenario
  for (const r of results) {
    const netLog = path.join(ARTIFACTS_DIR, 'network', `${r.id}.json`);
    fs.mkdirSync(path.dirname(netLog), { recursive: true });
    fs.writeFileSync(netLog, JSON.stringify(r.networkRequests || [], null, 2));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const progressCommentId = readProgressCommentId();
  let checkRunId          = null;

  try {
    // ── Step 1: Fetch PR data ──────────────────────────────────────────────
    console.log(`\n📥 Fetching PR #${PR_NUMBER} data...`);
    await updateProgress(progressCommentId, '> 📥 Fetching PR data...');
    const prData = await github.getPRData(PR_NUMBER);
    console.log(`   Title: ${prData.title}`);
    console.log(`   Files changed: ${prData.rawFiles.length}`);

    // ── Step 2: Create a Check Run ────────────────────────────────────────
    checkRunId = await github.createCheckRun('Qwen Agentic Review', prData.headSha).catch(() => null);

    // ── Step 3: Generate test scenarios ───────────────────────────────────
    console.log('\n🧠 Asking Qwen to generate test scenarios...');
    await updateProgress(progressCommentId, '> 🧠 Generating test scenarios from diff...');

    const scenarios = await llm.generateTestScenarios({
      ...prData,
      baseUrl: BASE_URL,
    });

    console.log(`   Generated ${scenarios.length} scenario(s).`);
    scenarios.forEach(s => console.log(`   [${s.priority.toUpperCase()}] ${s.id}: ${s.title}`));

    // ── Step 4: Run Playwright ─────────────────────────────────────────────
    let testResults = [];

    if (scenarios.length === 0 || !BASE_URL) {
      console.log('\n⚠️  No scenarios or no APP_BASE_URL — skipping browser tests.');
      await updateProgress(progressCommentId, '> ⚠️ No browser tests to run (no APP_BASE_URL or no scenarios generated).');
    } else {
      console.log('\n🎭 Running Playwright scenarios...');
      await updateProgress(progressCommentId,
        `> 🎭 Running ${scenarios.length} browser test scenario(s) with Playwright...`
      );

      testResults = await runScenarios(
        scenarios.filter(s => s.priority === 'high' || s.priority === 'medium').slice(0, parseInt(process.env.MAX_SCENARIOS || '5')),
        BASE_URL,
      );

      const passed  = testResults.filter(r => r.status === 'passed').length;
      const failed  = testResults.filter(r => r.status === 'failed').length;
      const warning = testResults.filter(r => r.status === 'warning').length;
      console.log(`\n   Results: ✅ ${passed} passed | ❌ ${failed} failed | ⚠️ ${warning} warnings`);

      await updateProgress(progressCommentId,
        `> 🎭 Tests complete: ✅ ${passed} passed | ❌ ${failed} failed | ⚠️ ${warning} warnings\n> 🖊️ Generating review comment...`
      );
    }

    // ── Step 5: Generate review comment ───────────────────────────────────
    console.log('\n✍️  Asking Qwen to generate the review comment...');
    const reviewComment = await llm.generateReviewComment(prData, testResults);

    // ── Step 6: Persist artifacts ──────────────────────────────────────────
    persistResults(prData, scenarios, testResults, reviewComment);

    // ── Step 7: Post review to GitHub ─────────────────────────────────────
    console.log('\n📤 Posting review to GitHub...');

    const reviewEvent = testResults.length > 0
      ? determineReviewEvent(testResults)
      : 'COMMENT';

    // Post as a formal PR review (shows in "Files changed" tab)
    await github.submitReview(
      PR_NUMBER,
      prData.headSha,
      reviewComment,
      reviewEvent,
    );

    // Update the progress comment to the final result
    if (progressCommentId) {
      const passed  = testResults.filter(r => r.status === 'passed').length;
      const failed  = testResults.filter(r => r.status === 'failed').length;
      const eventLabel = reviewEvent === 'APPROVE'
        ? '✅ Approved'
        : reviewEvent === 'REQUEST_CHANGES'
        ? '❌ Changes Requested'
        : '💬 Review Posted';

      await github.updateComment(progressCommentId, [
        `## 🤖 Qwen Code Review — ${eventLabel}`,
        '',
        buildTestSummaryTable(testResults),
        '',
        `> Full review posted as a PR review. Check the "Files changed" tab.`,
        '',
        `⏱️ Completed at: ${new Date().toUTCString()}`,
      ].join('\n'));
    }

    // ── Step 8: Update Check Run ───────────────────────────────────────────
    if (checkRunId) {
      const failed = testResults.filter(r => r.status === 'failed').length;
      await github.completeCheckRun(checkRunId, {
        conclusion: failed > 0 ? 'failure' : 'success',
        title:      `Qwen Agentic Review — ${reviewEvent}`,
        summary:    `${scenarios.length} scenarios generated, ${testResults.length} executed. ${failed} failures.`,
      });
    }

    console.log('\n✅ Agentic review complete!\n');

  } catch (err) {
    console.error('\n💥 Agent failed:', err);

    // Update progress comment with failure
    if (progressCommentId) {
      await github.updateComment(progressCommentId, [
        '## 🤖 Qwen Code Review — ❌ Error',
        '',
        `The agent encountered an error: \`${err.message}\``,
        '',
        'Please check the workflow run logs for details.',
      ].join('\n')).catch(() => {});
    }

    // Fail the Check Run
    if (checkRunId) {
      await github.completeCheckRun(checkRunId, {
        conclusion: 'failure',
        title:      'Qwen Agentic Review — Error',
        summary:    err.message,
      }).catch(() => {});
    }

    process.exit(1);
  }
}

main();
