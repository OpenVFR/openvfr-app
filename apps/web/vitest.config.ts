import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // apps/native/src/utils/*.test.ts: native logic that needs no device (its modules are mocked in the test files)
    include: ['../../packages/shared/src/**/*.test.ts', 'src/**/*.test.ts', '../native/src/utils/*.test.ts'],
    environment: 'node',
  },
})
