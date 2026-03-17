# Professional Agentic QA: Using LLMs with Playwright MCP

This guide explains how to set up an **Agentic PR Reviewer** that uses any LLM (via an OpenAI-compatible API) to drive **Playwright MCP** for automated, functional testing of pull requests.

## 1. Prerequisites
*   **LLM API Access**: An API key from OpenAI, Anthropic (via proxy), Google (via proxy), or an aggregator like **OpenRouter**.
*   **Playwright MCP**: The `@modelcontextprotocol/server-playwright` server must be accessible to your agent.

## 2. Dynamic Model Support
While this demo was originally designed for Qwen-Code, it is **model-agnostic**. You can use any high-reasoning model that supports tool-calling (e.g., GPT-4o, Claude 3.5 Sonnet, or deepseek-coder).

### Configuration in Roo Code
1.  Set your **Provider** to "OpenAI Compatible" (or your specific provider).
2.  Input your **Base URL** (e.g., `https://openrouter.ai/api/v1`).
3.  Choose your **Model ID** (e.g., `anthropic/claude-3.5-sonnet` or `google/gemini-2.0-flash-exp:free`).
4.  Enable **Playwright MCP** in your MCP settings.

## 3. The "Agentic Review" Workflow
On GitHub, the [.github/workflows/agentic-pr-review.yml](file:///home/benie/Projects/converse-all/playwright-demo/.github/workflows/agentic-pr-review.yml) workflow handles the automation:

*   **Trigger**: Comments starting with `/agent-test` or new PR synchronizations.
*   **Action**: The workflow spins up a Node.js environment, installs Playwright, and invokes your Agent.
    > "Review the changes in this PR. Use Playwright to navigate to the app and confirm the modified features still work as expected. Report any regressions visually or functionally."

## 4. How to Trigger via GitHub Comments
You can invoke the agent on-demand by commenting on any Pull Request.

*   **Default Command**: Type `/agent-test` in a PR comment.
*   **Customization**: To change the trigger (e.g. to `@qwencoder /review`), modify the `if` condition in `.github/workflows/agentic-pr-review.yml`:
    ```yaml
    if: |
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '/your-command'))
    ```

## 4. Why Use an External Provider?
Using an OpenAI-compatible provider (like OpenRouter) allows you to:
*   **Switch Models Easily**: Use the best model for the task (e.g., switch to Qwen for complex coding or GPT-4 for logic-heavy verification).
*   **Unified API**: Connect multiple agents to the same endpoint.
*   **Cost Management**: Monitor and limit usage across different providers from one dashboard.

> [!IMPORTANT]
> **Comment Triggers & Default Branch**: GitHub Actions only processes `issue_comment` events if the workflow file exists on your repository's **default branch** (usually `main`). If you add a new command-triggered workflow on a feature branch, it will not work until that file is pushed to `main`.

## 5. Security Best Practices
> [!IMPORTANT]
> Store your `LLM_API_KEY` in **GitHub Actions Secrets**. Use **GitHub Actions Variables** for non-sensitive data like `LLM_MODEL` or `LLM_BASE_URL`.
