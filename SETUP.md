# 🤖 Qwen Agentic PR Review — Setup & Usage Guide

A GitHub Actions workflow that automatically reviews your pull requests by:
1. Analysing the code diff with Qwen Code
2. Generating and running Playwright browser tests autonomously
3. Capturing screenshots, network logs, and console errors
4. Posting a detailed review comment directly on the PR

---

## 📁 File Structure

```
your-repo/
├── .github/
│   └── workflows/
│       └── agentic-pr-review.yml     ← The workflow
│
└── scripts/
    └── agent/
        ├── package.json              ← Agent dependencies
        ├── autonomous_agent.js       ← Main orchestrator
        ├── llm_client.js             ← Qwen API wrapper (text + vision)
        ├── playwright_runner.js      ← Autonomous Playwright executor
        └── github_client.js          ← GitHub REST API client
```

---

## ⚙️ One-Time Setup

### Step 1 — Add Repository Secrets

Go to **Settings → Secrets and variables → Actions → Secrets** and add:

| Secret | Description | Example |
|---|---|---|
| `LLM_API_KEY` | Your Qwen / DashScope API key | `sk-xxxxxxxxxxxxxxxx` |
| `LLM_BASE_URL` | Qwen OpenAI-compatible base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

> **GitHub Token:** `GITHUB_TOKEN` is automatically provided by Actions — no setup needed.

---

### Step 2 — Add Repository Variables

Go to **Settings → Secrets and variables → Actions → Variables** and add:

| Variable | Default | Description |
|---|---|---|
| `LLM_MODEL` | `qwen-coder-plus` | Text model for code analysis and scenario generation |
| `LLM_VL_MODEL` | `qwen-vl-plus` | Vision model for screenshot analysis |
| `APP_BASE_URL` | *(empty)* | Base URL of your deployed preview/staging app |
| `MAX_SCENARIOS` | `5` | Max number of test scenarios to run per PR |

> **Important:** If `APP_BASE_URL` is left empty, the agent will still review the code diff but will skip browser tests.

---

### Step 3 — Copy the Files

Copy all files into your repository maintaining the directory structure shown above. Then commit and push:

```bash
git add .github/workflows/agentic-pr-review.yml scripts/agent/
git commit -m "chore: add Qwen agentic PR review"
git push
```

---

### Step 4 — Grant Workflow Permissions

Go to **Settings → Actions → General → Workflow permissions** and select:
- ✅ **Read and write permissions**
- ✅ **Allow GitHub Actions to create and approve pull requests**

---

## 🚀 How to Trigger a Review

### Automatic (on every PR)
The review runs automatically when:
- A pull request is **opened**
- A pull request is **updated** (new commit pushed)
- A pull request is **reopened**

### Manual (comment command)
Comment exactly this on any PR:

```
@qwen-code review
```

The bot will react with 👀 to acknowledge, then post its review when done.

> The comment must be on its own line and match exactly (case-insensitive).

---

## 📤 What Gets Posted

### 1. Progress Comment
An in-progress notice is posted immediately so you know the bot is working.

### 2. Formal PR Review
A full GitHub PR review (the kind that shows in the **Files changed** tab) containing:

```
## 🤖 Qwen Code Review

### 📋 Summary
...

### 🧪 Automated Test Results
| | Scenario | Status | Summary |
...

### 🌐 Network Observations
...

### 🖥️ Visual Findings
...

### 🔍 Code Analysis
...

### ✅ Recommendations
...

### 📊 Verdict
APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION
```

### 3. Artifacts
Downloadable from the Actions run:
```
agentic-review-pr-<N>/
├── summary.json                  ← Machine-readable results
├── review_comment.md             ← Raw Markdown of the review
├── screenshots/
│   └── TC-01/
│       ├── 00-initial.png
│       ├── step-1.png
│       ├── step-3.png
│       └── 99-final.png
├── videos/
│   └── TC-01/                    ← Full test video
└── network/
    └── TC-01.json                ← All network requests captured
```

---

## 🔧 Configuration Reference

### Using a Preview URL (Recommended)

If your CI pipeline deploys a preview URL for each PR, pass it through:

```yaml
# In your deploy workflow, after deploying:
- name: Set preview URL as variable
  run: |
    echo "APP_BASE_URL=https://preview-${{ github.event.pull_request.number }}.your-app.com" >> $GITHUB_ENV
```

Or set it statically in your staging environment:

```
APP_BASE_URL = https://staging.your-app.com
```

### Controlling Which Scenarios Run

The agent filters scenarios by priority before running them:
- `high` and `medium` scenarios are always run
- `low` scenarios are skipped (they still appear in the review)
- Total cap: `MAX_SCENARIOS` (default: 5)

### Restricting Which PRs Get Reviewed

Add a path filter to the workflow trigger to skip non-frontend changes:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'src/**'
      - 'pages/**'
      - 'components/**'
      - 'app/**'
```

---

## 🤖 Supported Qwen Models

| Model | Use | Notes |
|---|---|---|
| `qwen-coder-plus` | Code analysis, scenario generation, review writing | Best for code tasks |
| `qwen-coder-turbo` | Faster, cheaper alternative | Slightly less accurate |
| `qwen-vl-plus` | Screenshot analysis | Requires vision capability |
| `qwen-vl-max` | Best screenshot analysis | Higher cost |

Set via the `LLM_MODEL` and `LLM_VL_MODEL` repository variables.

---

## 🛠️ Troubleshooting

### Review not triggering on PR

**Check:**
1. Workflow permissions are set to "Read and write" (Step 4 above)
2. The workflow file is on your default branch (not just the PR branch)
3. Secrets are set correctly — a missing `LLM_API_KEY` will cause a silent failure

### `@qwen-code review` command not working

**Check:**
1. The comment is on a **pull request**, not a regular issue
2. The comment matches exactly: `@qwen-code review` (no extra text on the same line)
3. The `GITHUB_TOKEN` has write access to issues/PRs

### No browser tests running

**Check:**
- `APP_BASE_URL` variable is set and points to a reachable URL
- The URL is accessible from GitHub Actions runners (not `localhost`)
- Playwright browsers are installing correctly — check the "Install Playwright browsers" step logs

### Review comment looks generic

This usually means the diff was empty or too large. Check:
- The PR has actual file changes (not just merge commits)
- The diff isn't truncated (it's capped at 8000 chars in the LLM prompt for cost reasons — adjust in `llm_client.js` if needed)

---

## 💡 Tips

- **Preview environments**: The biggest quality boost comes from pointing `APP_BASE_URL` at a real preview deployment. Without it, the agent can only review code, not test the running app.
- **Tagging important tests**: You can add instructions to the PR description like `Test the login flow specifically` — Qwen reads the PR description and will prioritise those scenarios.
- **Cost management**: Each review costs roughly 3–8 LLM API calls. Set `MAX_SCENARIOS=3` to cap costs on high-volume repos.
- **Nightly runs**: Combine with a scheduled workflow for full regression runs against staging — just pass `PR_NUMBER=0` and a static `APP_BASE_URL`.
