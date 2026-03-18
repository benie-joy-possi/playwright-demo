'use strict';

/**
 * github_client.js
 * All interactions with the GitHub REST API.
 * Uses @octokit/rest under the hood.
 */

const { Octokit } = require('@octokit/rest');

const token = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
const octokit = new Octokit({ auth: token });

// Parse "owner/repo" from GITHUB_REPOSITORY env var
function parseRepo() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY env var is missing or malformed.');
  return { owner, repo };
}

// ── PR data ───────────────────────────────────────────────────────────────────

/**
 * Returns basic PR metadata + the unified diff.
 */
async function getPRData(prNumber) {
  const { owner, repo } = parseRepo();

  const [prResp, diffResp, filesResp] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: prNumber,
      headers: { accept: 'application/vnd.github.v3.diff' },
    }),
    octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 }),
  ]);

  const pr = prResp.data;

  return {
    number: prNumber,
    title: pr.title,
    description: pr.body || '',
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    author: pr.user.login,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    diff: typeof diffResp.data === 'string' ? diffResp.data : '',
    changedFiles: filesResp.data.map(f => `${f.status.toUpperCase().padEnd(8)} ${f.filename}`),
    rawFiles: filesResp.data,
  };
}

// ── Comments ──────────────────────────────────────────────────────────────────

async function createComment(prNumber, body) {
  const { owner, repo } = parseRepo();
  const { data } = await octokit.issues.createComment({
    owner, repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

async function updateComment(commentId, body) {
  const { owner, repo } = parseRepo();
  await octokit.issues.updateComment({
    owner, repo,
    comment_id: commentId,
    body,
  });
}

async function deleteComment(commentId) {
  const { owner, repo } = parseRepo();
  await octokit.issues.deleteComment({ owner, repo, comment_id: commentId }).catch(() => { });
}

// ── Review (inline + summary) ─────────────────────────────────────────────────

/**
 * Posts a formal PR review (the kind that shows up in the "Files changed" tab).
 * @param {string} body         — Markdown body for the review summary
 * @param {'COMMENT'|'APPROVE'|'REQUEST_CHANGES'} event
 */
async function submitReview(prNumber, headSha, body, event = 'COMMENT') {
  const { owner, repo } = parseRepo();
  await octokit.pulls.createReview({
    owner, repo,
    pull_number: prNumber,
    commit_id: headSha,
    body,
    event,
  });
}

// ── Reactions ─────────────────────────────────────────────────────────────────

async function reactToComment(commentId, reaction) {
  const { owner, repo } = parseRepo();
  await octokit.reactions.createForIssueComment({
    owner, repo,
    comment_id: commentId,
    content: reaction,
  }).catch(() => { });   // reactions are best-effort
}

// ── Check run (status indicator on commit) ────────────────────────────────────

async function createCheckRun(name, headSha) {
  const { owner, repo } = parseRepo();
  const { data } = await octokit.checks.create({
    owner, repo, name,
    head_sha: headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
  });
  return data.id;
}

async function completeCheckRun(checkRunId, { conclusion, title, summary }) {
  const { owner, repo } = parseRepo();
  await octokit.checks.update({
    owner, repo,
    check_run_id: checkRunId,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: { title, summary },
  }).catch(err => console.warn('Check run update failed (non-fatal):', err.message));
}

module.exports = {
  getPRData,
  createComment,
  updateComment,
  deleteComment,
  submitReview,
  reactToComment,
  createCheckRun,
  completeCheckRun,
};
