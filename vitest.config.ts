import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      NODE_ENV: 'test',
      DB_NAME: process.env.TEST_DB_NAME || 'gallowmere_test',
      DB_USER: process.env.TEST_DB_USER || process.env.DB_USER || 'gallowmere',
      DB_PASSWORD: process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD || 'devpass',
      DB_HOST: process.env.DB_HOST || 'localhost',
      ADMIN_NAMES: 'Shane',
    },
  },
});
