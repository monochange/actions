import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isMap, isSeq, parseDocument } from 'yaml';

const workflow = parseDocument(readFileSync('.github/workflows/release-publish.yml', 'utf8'));
const refExpression = `\${{ inputs.ref || 'HEAD' }}`;
const steps = workflow.getIn(['jobs', 'publish', 'steps'], true);

if (!isSeq(steps)) {
  throw new Error('The release workflow must have publication steps.');
}

const detection = steps.items.find((step) => isMap(step) && step.get('id') === 'release_record');

if (!isMap(detection)) {
  throw new Error('The release workflow must detect release records.');
}

const detectionRun: unknown = detection.get('run');

if (typeof detectionRun !== 'string') {
  throw new Error('Release detection must have a Bash script.');
}

const detectionScript = detectionRun;

let directory: string;
let head: string;
let previous: string;

/** Run real Git against a disposable repository without changing signing configuration. */
function git(...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release test',
      GIT_AUTHOR_EMAIL: 'release@example.invalid',
      GIT_COMMITTER_NAME: 'Release test',
      GIT_COMMITTER_EMAIL: 'release@example.invalid',
    },
  });
  expect(result.status, result.stderr).toBe(0);

  return result.stdout.trim();
}

/** Execute the workflow script with a CLI stub so no publication or credentials are needed. */
function detect(ref: string, cliResult = 'true', cliStatus = '0') {
  const result = spawnSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      detectionScript.replaceAll(refExpression, ref),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        RELEASE_REF: ref,
        GITHUB_OUTPUT: join(directory, 'output'),
        GITHUB_ENV: join(directory, 'environment'),
        GITHUB_PATH: join(directory, 'path'),
        CLI_RESULT: cliResult,
        CLI_STATUS: cliStatus,
      },
    },
  );

  return {
    ...result,
    output: readFileSync(join(directory, 'output'), 'utf8'),
    calls: readFileSync(join(directory, 'calls'), 'utf8'),
  };
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'release-ref-'));
  git('init', '--quiet');
  const tree = git('mktree');
  previous = git('commit-tree', tree, '-m', 'ordinary commit');
  head = git('commit-tree', tree, '-p', previous, '-m', 'chore(release): prepare release');
  git('update-ref', 'HEAD', head);
  git('tag', 'release-candidate', head);

  writeFileSync(
    join(directory, 'pnpm'),
    `#!/bin/bash
printf '%s\\n' "$@" > calls
printf '%s\\n' "$CLI_RESULT"
exit "$CLI_STATUS"
`,
    { mode: 0o755 },
  );
});

beforeEach(() => {
  git('update-ref', 'HEAD', head);
  rmSync(join(directory, 'injected'), { force: true });

  for (const name of ['output', 'environment', 'path', 'calls']) {
    writeFileSync(join(directory, name), '');
  }
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('release publication ref boundary', () => {
  it('passes the dispatch ref through the environment instead of shell source', () => {
    expect(detection.getIn(['env', 'RELEASE_REF'])).toBe(refExpression);
    expect(detectionScript).not.toContain('${{');
  });

  it.each(['HEAD', 'release-candidate', 'release-candidate^{}'])(
    'accepts %s as the checkout commit',
    (ref) => {
      const result = detect(ref);
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe('is_release_commit=true\n');
      expect(result.calls.split('\n')).toContain(head);
    },
  );

  it('accepts an immutable commit ID', () => {
    expect(detect(head).output).toBe('is_release_commit=true\n');
  });

  it.each([
    '$(touch injected)',
    '`touch injected`',
    'HEAD"; touch injected; #',
    'HEAD"\ntouch injected\n#',
    'HEAD; touch injected',
    'HEAD"; printf injected >> "$GITHUB_ENV"; #',
    'HEAD"; printf injected >> "$GITHUB_PATH"; #',
    '--help',
    'missing-ref',
    'HEAD^{tree}',
  ])('rejects unsafe or invalid ref %j before calling the CLI', (ref) => {
    const result = detect(ref);
    expect(existsSync(join(directory, 'injected'))).toBe(false);
    expect(readFileSync(join(directory, 'environment'), 'utf8')).toBe('');
    expect(readFileSync(join(directory, 'path'), 'utf8')).toBe('');
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
    expect(result.calls).toBe('');
  });

  it('rejects a different commit before enabling publication of HEAD', () => {
    const result = detect(previous);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
    expect(result.calls).toBe('');
  });

  it('skips publication for a valid non-release commit', () => {
    expect(detect('HEAD', 'false').output).toBe('is_release_commit=false\n');
  });

  it('fails when a release-looking commit has no readable release record', () => {
    const result = detect('HEAD', '', '1');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Release-looking commit could not be read');
    expect(result.output).toBe('');
  });

  it('skips an ordinary commit with no release record', () => {
    git('update-ref', 'HEAD', previous);
    const result = detect('HEAD', '', '1');
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('is_release_commit=false\n');
  });
});
