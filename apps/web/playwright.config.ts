import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: [
        // Synthetic camera/microphone/screen so WebRTC flows run headless.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // Stale processes from an interrupted run would hold the ports.
        command: 'node ../../scripts/kill-ports.mjs && pnpm --dir ../.. dev',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'ignore',
        env: {
          // Every test runs from one address; production-like limits would throttle the suite.
          RATE_LIMIT_MAX: '1000000',
          RATE_LIMIT_AUTH_MAX: '1000000',
          RATE_LIMIT_MESSAGES_MAX: '1000000',
          MEDIA_NUM_WORKERS: process.env.MEDIA_NUM_WORKERS ?? '4',
        },
      },
});
