import { defineConfig } from 'vitest/config'

const cliTestTimeout = 30_000

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    // CLI integrations start the built executable in fresh processes, including on shared runners.
    testTimeout: cliTestTimeout,
    hookTimeout: cliTestTimeout,
    globalSetup: ['tests/temp-root.ts'],
  },
})
