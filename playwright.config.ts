import { defineConfig, devices } from 'playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // Keep Playwright's automatic output cleanup away from persistent AI-eval
  // evidence stored under test-results/ai-eval.
  outputDir: './test-results/playwright',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 5'],
      },
    },
  ],
})
