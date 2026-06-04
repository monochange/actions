import { describe, expect, it } from 'vitest';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const variants = [
  'check',
  'release-preview',
  'release-record',
  'open-release-request',
  'tag-release',
  'publish-readiness',
  'publish-packages',
];

describe('new monochange action layout', () => {
  it('has a TypeScript implementation and path action metadata for each new variant', () => {
    for (const variant of variants) {
      expect(
        existsSync(join('src/actions', variant, 'index.ts')),
        `${variant} implementation`,
      ).toBe(true);
      expect(existsSync(join(variant, 'action.yml')), `${variant} action.yml`).toBe(true);
      expect(existsSync(join(variant, 'README.md')), `${variant} README`).toBe(true);
    }
  });

  it('exposes every new variant from the root action metadata', () => {
    const rootAction = readFileSync('action.yml', 'utf8');

    for (const variant of variants) {
      expect(rootAction).toContain(variant);
    }
  });
});
