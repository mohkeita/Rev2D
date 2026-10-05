import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Test files that drive the built editor UI in headless Chrome (playwright-core). Chrome draws the
 * WebGL viewport with a software rasterizer (SwiftShader) on many threads for as long as a page is
 * open, so these files starve whatever runs next to them. They are a project of their own that runs
 * after the other test files, one file at a time (10 - 20 s each).
 *
 * Measured on a 24-thread machine: alone, everything in one group takes 30 s and this split 55 s. With
 * a second test run going on at the same time (another agent, a build), one group fell apart: 38 failed
 * tests in each run, all over the suite, and workers that did not start. With the split every other
 * test passed each time; only the Chrome-driven tests of the two runs still got in each other's way.
 */
const CHROME_TESTS = ['test/**/*-e2e.test.ts'];

export default defineConfig({
  test: {
    testTimeout: 30000,
    // Hooks start editor servers and run whole exports: they get the time tests get (default 10 s).
    hookTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...CHROME_TESTS],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'chrome',
          include: CHROME_TESTS,
          fileParallelism: false,
          // Software-rendered Chrome answers slowly on a loaded machine (a 2 s test took 30 s).
          testTimeout: 120000,
          hookTimeout: 120000,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
