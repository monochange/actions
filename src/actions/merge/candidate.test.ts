import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const branch = 'monochange/release/test';
const bundle = resolve('dist/index.mjs');
let directory: string;
let remote: string;
let baseSha: string;
let originalSha: string;
let apiUrl: string;
let role: string;
let dispatches: number;
let advanceOnFinalRead: boolean;
let pullReads: number;
let templateDir: string | undefined;
let checks: Map<string, string>;
let checkedRefs: string[];
let server: ReturnType<typeof createServer>;

/** Runs fixture Git without reading the machine's identity, signing keys, or credential helpers. */
async function git(args: string[], input?: string): Promise<string> {
  const child = execFile('git', ['--git-dir', remote, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });

  if (input !== undefined) {
    child.stdin?.end(input);
  }

  return new Promise((resolveResult, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr));
        return;
      }
      resolveResult(stdout.trim());
    });
  });
}

/** Writes fixed commit objects as test data; no development commits or signing configuration are changed. */
async function commit(file: string, content: string, parent?: string): Promise<string> {
  const blob = await git(['hash-object', '-w', '--stdin'], content);
  const tree = await git(['mktree'], `100644 blob ${blob}\t${file}\n`);
  const parents = parent ? `parent ${parent}\n` : '';

  return git(
    ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\n${parents}author Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nFixture\n`,
  );
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', apiUrl).pathname;
  let data: unknown;

  if (path.endsWith('/pulls/42')) {
    pullReads += 1;

    if (advanceOnFinalRead && pullReads === 2) {
      const next = await commit('concurrent.txt', 'concurrent', originalSha);
      await git(['update-ref', `refs/heads/${branch}`, next]);
    }

    const repository = { clone_url: remote, full_name: 'example/project' };
    data = {
      number: 42,
      state: 'open',
      mergeable: true,
      html_url: 'https://github.com/example/project/pull/42',
      base: { ref: 'main', repo: repository, sha: await git(['rev-parse', 'refs/heads/main']) },
      head: {
        ref: branch,
        repo: repository,
        sha: await git(['rev-parse', `refs/heads/${branch}`]),
      },
    };
  } else if (path.endsWith('/check-runs')) {
    const sha = path.split('/').at(-2) ?? '';
    checkedRefs.push(sha);
    const state = checks.get(sha);
    data = {
      check_runs: state
        ? [
            {
              name: 'test',
              status: state === 'pending' ? 'queued' : 'completed',
              conclusion: state,
            },
          ]
        : [],
    };
  } else if (path.endsWith('/status')) {
    data = { statuses: [], total_count: 0, state: 'pending' };
  } else if (path.endsWith('/permission')) {
    data = { role_name: role };
  } else if (path.endsWith('/dispatches')) {
    dispatches += 1;
    response.writeHead(204).end();
    return;
  } else {
    response.writeHead(404).end();
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

async function run(inputs: Record<string, string> = {}) {
  const output = join(directory, 'output');
  const summary = join(directory, 'summary');
  await writeFile(output, '');
  await writeFile(summary, '');
  const values = {
    name: 'merge',
    repository: 'example/project',
    'github-token': 'fixture-token',
    'pull-request': '42',
    'base-branch': 'main',
    'head-branch-prefix': 'monochange/release/',
    'merge-method': 'fast-forward',
    'minimum-reviewer-permission': 'admin',
    'require-green-checks': 'true',
    'update-branch-on-failure': 'true',
    'trigger-command': '/merge',
    comment: 'never',
    ...inputs,
  };
  let succeeded = true;
  let errorMessage = '';

  try {
    await execute(process.execPath, [bundle], {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TEMPLATE_DIR: templateDir,
        GITHUB_API_URL: apiUrl,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_ACTOR: 'maintainer',
        GITHUB_REPOSITORY: 'example/project',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        ...Object.fromEntries(
          Object.entries(values).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, value]),
        ),
      },
    });
  } catch (error) {
    succeeded = false;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const contents = await readFile(output, 'utf8');
  const outputs: Record<string, string> = {};
  const entries = contents.matchAll(/^(.*?)<<([^\n]+)\n([\s\S]*?)\n\2$/gm);

  for (const entry of entries) {
    if (entry[1] && entry[3] !== undefined) outputs[entry[1]] = entry[3];
  }

  return { succeeded, outputs, summary: (await readFile(summary, 'utf8')) || errorMessage };
}

describe('published merge action', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'merge-regression-'));
    remote = join(directory, 'remote.git');
    await execute('git', ['init', '--bare', remote]);
    const ancestor = await commit('root.txt', 'root');
    baseSha = await commit('base.txt', 'base', ancestor);
    originalSha = await commit('release.txt', 'release', ancestor);
    await git(['update-ref', 'refs/heads/main', baseSha]);
    await git(['update-ref', `refs/heads/${branch}`, originalSha]);
    role = 'admin';
    dispatches = 0;
    advanceOnFinalRead = false;
    pullReads = 0;
    templateDir = undefined;
    checks = new Map([[originalSha, 'success']]);
    checkedRefs = [];
    server = createServer((request, response) => {
      void serve(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture API address');
    apiUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterEach(async () => {
    await new Promise<void>((done, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else done();
      });
    });
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['fast-forward', 'cherry-pick'])(
    'checks the prepared %s commit before a later base push',
    async (method) => {
      const inputs = { 'merge-method': method, 'post-update-workflow': 'checks.yml' };
      const prepared = await run(inputs);
      expect(prepared.succeeded, prepared.summary).toBe(true);
      expect(prepared.outputs).toMatchObject({ result: 'updated', merged: 'false' });
      const candidate = await git(['rev-parse', `refs/heads/${branch}`]);
      expect(candidate).not.toBe(originalSha);
      expect(prepared.outputs['head-sha']).toBe(candidate);
      expect(await git(['rev-parse', 'refs/heads/main'])).toBe(baseSha);
      expect(prepared.summary).toContain('fresh checks');
      expect(prepared.summary).not.toContain('Check validation: passed');
      expect(dispatches).toBe(method === 'fast-forward' ? 1 : 0);

      for (const state of [undefined, 'pending', 'failure', 'cancelled']) {
        if (state) checks.set(candidate, state);
        const blocked = await run(inputs);
        expect(blocked.succeeded, blocked.summary).toBe(false);
        expect(await git(['rev-parse', 'refs/heads/main'])).toBe(baseSha);
      }

      checks.set(candidate, 'success');
      const merged = await run(inputs);
      expect(merged.succeeded, merged.summary).toBe(true);
      expect(merged.outputs).toMatchObject({
        result: 'fast-forwarded',
        merged: 'true',
        'head-sha': candidate,
      });
      expect(await git(['rev-parse', 'refs/heads/main'])).toBe(candidate);
      expect(checkedRefs.at(-1)).toBe(candidate);
    },
    120_000,
  );

  it.each(['fast-forward', 'cherry-pick'])(
    'leaves both branches unchanged in a %s dry run',
    async (method) => {
      const result = await run({ 'merge-method': method, 'dry-run': 'true' });
      expect(result.succeeded, result.summary).toBe(true);
      expect(result.outputs.result).toBe('dry-run');
      expect(await git(['rev-parse', 'refs/heads/main'])).toBe(baseSha);
      expect(await git(['rev-parse', `refs/heads/${branch}`])).toBe(originalSha);
    },
    60_000,
  );

  it('rejects an unauthorized actor before updating either branch', async () => {
    role = 'read';
    const result = await run();
    expect(result.succeeded).toBe(false);
    expect(result.summary).toContain('requires at least');
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(baseSha);
    expect(await git(['rev-parse', `refs/heads/${branch}`])).toBe(originalSha);
  }, 60_000);

  it('preserves a concurrent PR head update with a push lease', async () => {
    const concurrentSha = await commit('concurrent.txt', 'concurrent', originalSha);
    templateDir = join(directory, 'template');
    await mkdir(join(templateDir, 'hooks'), { recursive: true });
    // The hook races the ref update after the client receives the remote's advertised head.
    await writeFile(
      join(templateDir, 'hooks/pre-push'),
      `#!/bin/sh\ngit --git-dir="$2" update-ref refs/heads/${branch} ${concurrentSha}\n`,
      { mode: 0o755 },
    );
    const result = await run();
    expect(result.succeeded).toBe(false);
    expect(result.summary).toContain('rejected');
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(baseSha);
    expect(await git(['show', `${branch}:concurrent.txt`])).toBe('concurrent');
  }, 60_000);

  it.each(['fast-forward', 'cherry-pick'])(
    'leaves the base unchanged after a %s conflict',
    async (method) => {
      const ancestor = await git(['rev-parse', `${originalSha}^`]);
      baseSha = await commit('release.txt', 'conflicting release', ancestor);
      await git(['update-ref', 'refs/heads/main', baseSha]);

      const result = await run({ 'merge-method': method });

      expect(result.succeeded).toBe(false);
      expect(result.summary).toContain('failed');
      expect(await git(['rev-parse', 'refs/heads/main'])).toBe(baseSha);
      expect(await git(['rev-parse', `refs/heads/${branch}`])).toBe(originalSha);
    },
    60_000,
  );

  it('stops if a post-update hook fails without using old checks to merge', async () => {
    const result = await run({ 'post-update-script': 'exit 23' });

    expect(result.succeeded).toBe(false);
    expect(result.summary).toContain('Post-update script failed');
    expect(result.summary).not.toContain('Check validation: passed');
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(baseSha);
    expect(await git(['rev-parse', `refs/heads/${branch}`])).not.toBe(originalSha);
  }, 60_000);

  it('rejects a checked head that moves before the final base push', async () => {
    originalSha = await commit('release.txt', 'release', baseSha);
    await git(['update-ref', `refs/heads/${branch}`, originalSha]);
    checks.set(originalSha, 'success');
    advanceOnFinalRead = true;

    const result = await run();

    expect(result.succeeded).toBe(false);
    expect(result.summary).toContain('head changed after check validation');
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(baseSha);
  }, 60_000);
});
