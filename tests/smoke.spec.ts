import { test, expect } from '@playwright/test';

const basePath = process.env.GITHUB_WORKSPACE || process.cwd();

test.describe('Smoke Tests', () => {
  test('homepage loads successfully', async ({ page }) => {
    await page.goto(`file://${basePath}/index.html`);
    await expect(page).toHaveTitle(/Marketplace/);
  });

  test('login form is present', async ({ page }) => {
    await page.goto(`file://${basePath}/index.html`);
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#login-btn')).toBeVisible();
  });
});
