import { defineConfig } from 'tsdown';

import { readMonochangeRelease } from './scripts/monochange-release.ts';

export default defineConfig({
  entry: { index: 'src/main.ts' },
  format: 'esm',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  platform: 'node',
  treeshake: true,
  dts: false,
  minify: false,
  report: false,
  deps: {
    alwaysBundle: ['@actions/core', '@actions/exec', '@actions/github'],
    onlyBundle: false,
  },
  define: { __MONOCHANGE_RELEASE__: JSON.stringify(readMonochangeRelease()) },
});
