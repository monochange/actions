import { describe, expect, it } from 'vitest';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

const actionsDirectory = 'src/actions';

/** Variant directories are the implementations under src/actions. */
const variants = readdirSync(actionsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => existsSync(join(actionsDirectory, entry.name, 'index.ts')))
  .map((entry) => entry.name)
  .toSorted();

type ActionMetadata = {
  inputs?: Record<string, { default?: string }>;
};

/**
 * `publish-plan` was removed from the dispatcher when `publish-packages`
 * replaced it. Its path wrapper remains on disk, but it is not a supported
 * variant, so it is excluded from the selector invariant.
 */
const retiredVariants = new Set(['publish-plan']);

/** The dispatcher's case labels are the variants the bundle can run. */
function dispatchedVariants(): string[] {
  const source = readFileSync('src/main.ts', 'utf8');

  return [...source.matchAll(/case '([^']+)':/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('new monochange action layout', () => {
  it('finds the variant directories from disk', () => {
    expect(variants.length).toBeGreaterThan(0);
  });

  it('has a TypeScript implementation and path action metadata for each variant', () => {
    for (const variant of variants) {
      expect(
        existsSync(join('src/actions', variant, 'index.ts')),
        `${variant} implementation`,
      ).toBe(true);
      expect(existsSync(join(variant, 'action.yml')), `${variant} action.yml`).toBe(true);
      expect(existsSync(join(variant, 'README.md')), `${variant} README`).toBe(true);
    }
  });

  it('exposes every active variant from the root action metadata', () => {
    const rootAction = readFileSync('action.yml', 'utf8');

    for (const variant of variants) {
      if (!retiredVariants.has(variant)) {
        expect(rootAction).toContain(variant);
      }
    }
  });

  it('declares an internal name input matching each active variant directory', () => {
    for (const variant of variants) {
      if (!retiredVariants.has(variant)) {
        const metadata = parse(readFileSync(join(variant, 'action.yml'), 'utf8')) as ActionMetadata;

        expect(metadata.inputs?.name?.default, `${variant} inputs.name.default`).toBe(variant);
      }
    }
  });

  it('dispatches every active variant directory and no retired one', () => {
    const activeVariants = variants.filter((variant) => !retiredVariants.has(variant));

    expect(dispatchedVariants().toSorted()).toEqual(activeVariants);
  });

  it('keeps the retired variant directories documented by the exception', () => {
    for (const variant of retiredVariants) {
      expect(variants).toContain(variant);
    }
  });
});
