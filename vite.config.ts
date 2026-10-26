import { defineConfig } from 'vite-plus';

import { readMonochangeRelease } from './scripts/monochange-release';

export default defineConfig({
  define: { __MONOCHANGE_RELEASE__: JSON.stringify(readMonochangeRelease()) },
  fmt: {
    ignorePatterns: ['coverage/**', 'dist/**'],
    semi: true,
    singleQuote: true,
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: ['coverage/**', 'dist/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html', 'json', 'lcov'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
  pack: {
    define: { __MONOCHANGE_RELEASE__: JSON.stringify(readMonochangeRelease()) },
    clean: true,
    deps: {
      alwaysBundle: ['@actions/core', '@actions/exec', '@actions/github'],
      onlyBundle: false,
    },
    dts: false,
    entry: {
      index: 'src/main.ts',
    },
    format: ['esm'],
    outDir: 'dist',
    platform: 'node',
    sourcemap: true,
    target: 'node24',
  },
});
