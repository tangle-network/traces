import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    // CLI integrations start the built executable in fresh processes, including on shared runners.
    testTimeout: 30_000,
    globalSetup: ['tests/temp-root.ts'],
  },
})
