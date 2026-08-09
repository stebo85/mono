import { defineConfig, devices } from '@playwright/test'

// End-to-end tests that need a real browser: NiiVue's module graph uses Vite's
// `import.meta.glob` (so it can't be imported under the Bun unit-test runner) and
// its rendering/document round-trips need a GPU context. These run against the
// Vite dev server (source is served directly, same as the demos). Kept OUT of the
// hermetic unit `test` target — run with `bun run test:e2e` (or `nx e2e niivue`).

const PORT = 5273
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // Headless Chromium renders WebGL2 through SwiftShader; recent Chrome gates
    // that software path behind this flag.
    launchOptions: {
      args: ['--enable-unsafe-swiftshader'],
      // Opt-in escape hatch for a machine that has a headless shell but not
      // Playwright's exact pinned revision (a 92 MB download). Unset in CI, so
      // the pinned browser is still what gates a PR.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run e2e:serve',
    url: `${BASE_URL}/examples/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
