import { describe, expect, it } from 'vitest';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

const actionsDirectory = 'src/actions';

/** Read every variant from disk so a new directory cannot miss the metadata guard. */
const variantDirectories = readdirSync(actionsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => existsSync(join(actionsDirectory, entry.name, 'index.ts')))
  .map((entry) => entry.name)
  .toSorted();

const metadataFiles = [
  'action.yml',
  ...variantDirectories.map((variant) => join(variant, 'action.yml')),
];

type Described = {
  description?: string;
};

type ActionMetadata = Described & {
  inputs?: Record<string, Described>;
  outputs?: Record<string, Described>;
};

/** Collect every action-level, input, and output description with its metadata path. */
function descriptions(metadata: ActionMetadata): [string, string][] {
  const entries: [string, string][] = [];

  if (metadata.description !== undefined) {
    entries.push(['description', metadata.description]);
  }

  for (const field of ['inputs', 'outputs'] as const) {
    for (const [name, entry] of Object.entries(metadata[field] ?? {})) {
      if (entry.description !== undefined) {
        entries.push([`${field}.${name}.description`, entry.description]);
      }
    }
  }

  return entries;
}

describe('action metadata descriptions', () => {
  it.each(metadataFiles)('%s has no GitHub expression in a description', (file) => {
    const metadata = parse(readFileSync(file, 'utf8')) as ActionMetadata;
    const entries = descriptions(metadata);

    expect(entries.length, `${file} declares descriptions`).toBeGreaterThan(0);

    for (const [path, description] of entries) {
      // GitHub evaluates `${{ }}` in action metadata, where only `inputs` and
      // `runs` contexts exist, so a description must stay plain text.
      expect(description, `${file} ${path} must not contain \${{ }}`).not.toContain('${{');
    }
  });
});
