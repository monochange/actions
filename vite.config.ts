import { defineConfig } from 'vite-plus';

export default defineConfig({
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
      reporter: ['text', 'html'],
    },
  },
  pack: {
    clean: true,
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
