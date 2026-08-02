import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    /**
     * Seven test files spawn the CLI as a cold Node process that type-strips
     * and loads the whole module graph, and several of those calls already
     * allow themselves 30s. vitest's 5s default was SHORTER than the budget
     * those tests set for their own subprocess, so the two disagreed and a
     * passing test failed on nothing but a loaded machine — reproduced at 2/3
     * and 2/4 under concurrent suite runs. The outer budget has to cover the
     * inner ones.
     */
    testTimeout: 30_000,
  },
})
