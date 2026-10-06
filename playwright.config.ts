// End-to-end tests: Playwright drives the built Electron app (out/) against the docker test databases.
// `npm run test:e2e` builds first. Each test gets its own user data directory (tests/e2e/fixtures.ts).
// Set DATAGRIPPE_SHOTS_DIR to also collect the step screenshots in one folder.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  // One Electron app at a time: the tests share the two test databases.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  use: { trace: 'retain-on-failure' },
})
