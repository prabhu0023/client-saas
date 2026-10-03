import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Never scan git worktrees used by workflow agents — their copies of
    // src/ would double-run (and fail in a non-Next test env), as happened
    // after the inbox merge. Keep alongside the .gitignore entry.
    exclude: ['**/node_modules/**', '**/.worktrees/**', '**/.next/**'],
  },
})
