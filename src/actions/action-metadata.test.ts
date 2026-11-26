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
  inputs?: Record<string, Described & { default?: string; options?: string[] }>;
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

  it('declares release-cut and sync inputs across standalone and root manifests', () => {
    const root = parse(readFileSync('action.yml', 'utf8')) as ActionMetadata;
    const releasePr = parse(readFileSync('release-pr/action.yml', 'utf8')) as ActionMetadata;
    const postMerge = parse(
      readFileSync('post-merge-release/action.yml', 'utf8'),
    ) as ActionMetadata;
    const hostedRelease = parse(
      readFileSync('hosted-release/action.yml', 'utf8'),
    ) as ActionMetadata;
    const syncRelease = parse(readFileSync('sync-release/action.yml', 'utf8')) as ActionMetadata;

    expect(root.inputs?.mode?.default).toBe('');
    expect(root.inputs?.['minimum-reviewer-permission']?.options).toContain('write');

    for (const inputName of [
      'refresh',
      'banner-only',
      'from',
      'refresh-command',
      'minimum-reviewer-permission',
    ]) {
      expect(
        releasePr.inputs?.[inputName],
        `release-pr/action.yml input ${inputName}`,
      ).toBeDefined();
    }
    expect(releasePr.inputs?.['minimum-reviewer-permission']?.options).toContain('write');

    for (const inputName of ['sync-release', 'open-next-cut', 'base-branch', 'github-token']) {
      expect(
        postMerge.inputs?.[inputName],
        `post-merge-release/action.yml input ${inputName}`,
      ).toBeDefined();
    }

    for (const inputName of ['refresh', 'from']) {
      expect(
        hostedRelease.inputs?.[inputName],
        `hosted-release/action.yml input ${inputName}`,
      ).toBeDefined();
    }

    for (const inputName of ['name', 'from', 'mode', 'open-request', 'backend', 'hosted-url']) {
      expect(
        syncRelease.inputs?.[inputName],
        `sync-release/action.yml input ${inputName}`,
      ).toBeDefined();
    }
  });
});
