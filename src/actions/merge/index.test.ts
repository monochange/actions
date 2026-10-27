import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = join(root, 'src/actions/merge/fixtures');
const directories: string[] = [];

type Scenario = {
  conclusion?: string | null;
  missingChecks?: boolean;
  permissionError?: boolean;
  role?: string;
  pushError?: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Run the shipped action with local Git/API stand-ins and a real shell hook. */
async function runAction(
  options: {
    inputs?: Record<string, string>;
    scenario?: Scenario;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'merge regression '));
  directories.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const hookMarker = join(directory, 'hook-ran');
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = '-c' ]; then shift 2; fi
printf 'git %s\\n' "$*" >> "$MERGE_TEST_DIRECTORY/events"
case "$1" in
  rev-parse)
    if [ "$2" = 'refs/tmp/base' ]; then printf 'base-sha'
    elif [ -f "$MERGE_TEST_DIRECTORY/rebased" ]; then printf 'rebased-sha'
    else printf 'head-sha'; fi ;;
  merge-base)
    if [ "$2" = '--is-ancestor' ]; then
      test -f "$MERGE_TEST_DIRECTORY/rebased"; exit $?
    fi
    printf 'merge-base-sha' ;;
  rebase) touch "$MERGE_TEST_DIRECTORY/rebased" ;;
  push)
    if [ -f "$MERGE_TEST_DIRECTORY/push-error" ]; then
      printf 'head push failed' >&2; exit 1
    fi ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(join(directory, 'scenario.json'), JSON.stringify(options.scenario ?? {}));

  if (options.scenario?.pushError) {
    await writeFile(join(directory, 'push-error'), '');
  }
  await writeFile(
    join(directory, 'event.json'),
    JSON.stringify({
      comment: { body: '/fast-forward' },
      issue: { number: 42, pull_request: {} },
    }),
  );

  for (const name of ['events', 'outputs', 'summary']) {
    await writeFile(join(directory, name), '');
  }

  const inputs = {
    name: 'merge',
    'base-branch': 'main',
    comment: 'never',
    'github-token': 'test-merge-token',
    'head-branch-prefix': 'release/',
    'merge-method': 'fast-forward',
    'minimum-reviewer-permission': 'admin',
    'post-update-script': `test -n "$PATH" && test -z "$GITHUB_TOKEN$GH_TOKEN$ACTIONS_ID_TOKEN_REQUEST_TOKEN$MERGE_TEST_DIRECTORY" && ! printenv INPUT_GITHUB-TOKEN && touch ${shellQuote(hookMarker)}`,
    'post-update-workflow': 'release.yml',
    repository: 'example/project',
    'require-green-checks': 'true',
    'trigger-command': '/fast-forward',
    'update-branch-on-failure': 'true',
    ...options.inputs,
  };
  const result = await exec(
    process.execPath,
    ['--import', join(fixtures, 'github.ts'), join(root, 'dist/index.mjs')],
    {
      cwd: directory,
      timeout: 30_000,
      env: {
        PATH: [bin, dirname(process.execPath), process.env.PATH].filter(Boolean).join(':'),
        TMPDIR: tmpdir(),
        GITHUB_ACTOR: 'commenter',
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: join(directory, 'event.json'),
        GITHUB_OUTPUT: join(directory, 'outputs'),
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
        GITHUB_TOKEN: 'test-github-credential',
        GH_TOKEN: 'test-gh-credential',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-oidc-credential',
        MERGE_TEST_DIRECTORY: directory,
        ...Object.fromEntries(
          Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]),
        ),
      },
    },
  ).then(
    ({ stdout }) => ({ ok: true, stdout }),
    (error: unknown) => {
      if (!(error instanceof Error) || !('stdout' in error) || typeof error.stdout !== 'string') {
        throw error;
      }

      const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';

      return { ok: false, stdout: error.stdout + stderr };
    },
  );

  const events = await readFile(join(directory, 'events'), 'utf8');

  return {
    ...result,
    events: events.trim().split('\n').filter(Boolean),
    outputs: await readFile(join(directory, 'outputs'), 'utf8'),
    hookRan: await readFile(hookMarker, 'utf8').then(
      () => true,
      () => false,
    ),
  };
}

function expectNoUpdates(events: string[]): void {
  expect(events.some((event) => /^(git (push|rebase|cherry-pick)\b|dispatch$)/.test(event))).toBe(
    false,
  );
}

describe('published merge action preconditions', { timeout: 40_000 }, () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it.each(['read', 'write', 'maintain'])(
    'rejects an unauthorized %s actor before Git',
    async (role) => {
      const result = await runAction({ scenario: { role } });

      expect(result.ok).toBe(false);
      expectNoUpdates(result.events);
      expect(result.stdout).toContain('requires at least `admin`');
      expect(result.events.some((event) => event.startsWith('git '))).toBe(false);
      expect(result.hookRan).toBe(false);
    },
  );

  it('stops before Git when the authorization request fails', async () => {
    const result = await runAction({ scenario: { permissionError: true } });

    expect(result.ok).toBe(false);
    expectNoUpdates(result.events);
    expect(result.stdout).toContain('permission lookup failed');
    expect(result.events.some((event) => event.startsWith('git '))).toBe(false);
    expect(result.hookRan).toBe(false);
  });

  it.each(['failure', 'cancelled', null])(
    'rejects a blocked check (%s) before Git',
    async (conclusion) => {
      const result = await runAction({ scenario: { conclusion } });

      expect(result.ok).toBe(false);
      expectNoUpdates(result.events);
      expect(result.stdout).toMatch(/checks/i);
      expect(result.events.some((event) => event.startsWith('git '))).toBe(false);
      expect(result.hookRan).toBe(false);
    },
  );

  it('rejects missing checks before Git', async () => {
    const result = await runAction({ scenario: { missingChecks: true } });

    expect(result.ok).toBe(false);
    expectNoUpdates(result.events);
    expect(result.stdout).toContain('No checks were found');
    expect(result.events.some((event) => event.startsWith('git '))).toBe(false);
    expect(result.hookRan).toBe(false);
  });

  it('previews a divergent head without rebasing, pushing, or running hooks', async () => {
    const result = await runAction({ inputs: { 'dry-run': 'true' } });

    expectNoUpdates(result.events);
    expect(result.ok, result.stdout).toBe(true);
    expect(result.hookRan).toBe(false);
    expect(result.outputs).toContain('result<<');
    expect(result.outputs).toContain('\ndry-run\n');
    expect(result.outputs).toContain('\nhead-sha\n');
  });

  it('prepares the head and runs hooks without inherited credentials when allowed', async () => {
    const result = await runAction();

    expect(result.ok, result.stdout).toBe(true);
    expect(result.events).toContain(
      'git push --force-with-lease=refs/heads/release/next:head-sha origin rebased-sha:refs/heads/release/next',
    );
    expect(result.events).not.toContain('git push origin rebased-sha:refs/heads/main');
    expect(result.events).toContain('dispatch');
    expect(result.events.indexOf('permission')).toBeLessThan(result.events.indexOf('git init .'));
    expect(result.hookRan).toBe(true);
    expect(result.outputs).toContain('\nupdated\n');
  });

  it('stops before hooks and the base update when the head push fails', async () => {
    const result = await runAction({ scenario: { pushError: true } });

    expect(result.ok).toBe(false);
    expect(result.stdout).toContain('head push failed');
    expect(result.events).not.toContain('dispatch');
    expect(result.events).not.toContain('git push origin rebased-sha:refs/heads/main');
    expect(result.hookRan).toBe(false);
  });
});
