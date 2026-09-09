import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['../../packages/shared/src/**/*.test.ts'],
    environment: 'node',
  },
})
