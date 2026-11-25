import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const action = 'publish-draft-releases';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = join(root, 'dist/index.mjs');
const metadata = parse(readFileSync(join(root, action, 'action.yml'), 'utf8')) as {
  inputs?: Record<string, { default?: string }>;
};

let directory: string;
let bin: string;
let calls: string;
let output: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'publish-draft-bundle-'));
  bin = join(directory, 'bin');
  calls = join(directory, 'calls');
  output = join(directory, 'output');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALLS"
if [ "$1 $2" = "release view" ]; then
  printf '{"isDraft":false,"tagName":"v1.0.0"}\\n'
  exit 0
fi
printf 'unexpected gh call: %s\\n' "$*" >&2
exit 1
`,
    { mode: 0o755 },
  );
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('publish-draft-releases bundle dispatch', () => {
  it('runs from the action metadata name default without GITHUB_ACTION_PATH', () => {
    expect(existsSync(bundle), 'build dist/index.mjs before running the bundle test').toBe(true);

    // The runner injects the action.yml default as INPUT_NAME. A subpath
    // action gets no GITHUB_ACTION_PATH, so this default is the only selector.
    const nameDefault = metadata.inputs?.name?.default ?? '';
    expect(nameDefault, `${action} action.yml must declare inputs.name.default`).toBe(action);

    writeFileSync(calls, '');
    writeFileSync(output, '');

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GITHUB_ACTION_PATH;
    delete env.INPUT_NAME;
    Object.assign(env, {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GH_CALLS: calls,
      GITHUB_OUTPUT: output,
      'INPUT_PUBLISH-RELATED': 'false',
      'INPUT_RELEASE-TAG': 'v1.0.0',
      INPUT_REPOSITORY: 'owner/repo',
      INPUT_NAME: nameDefault,
    });

    const result = spawnSync(process.execPath, [bundle], { env, encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Release v1.0.0 is already public; nothing to publish.');
    expect(result.stdout).not.toContain('Unsupported action variant');
    expect(readFileSync(calls, 'utf8')).toContain('release view v1.0.0');
    expect(readFileSync(output, 'utf8')).toContain('result<<');
  });
});
