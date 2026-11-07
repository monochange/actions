import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { buildDecideArgs, buildVerifyArgs, parseWorkflows, resolveBase, runCi } from './index';
import { readGitHubContext, type CiGitHubContext } from './github-context';

const githubMock = vi.hoisted(() => ({
  context: {
    eventName: 'pull_request',
    payload: {} as unknown,
    ref: 'refs/pull/42/merge',
    sha: 'sha-123',
  },
}));

vi.mock('@actions/core', () => ({
  error: vi.fn(),
  getInput: vi.fn(),
  info: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@actions/github', () => githubMock);

vi.mock('../../shared/exec', () => ({ exec: vi.fn() }));

vi.mock('../../shared/monochange-cli', () => ({ resolveMonochange: vi.fn() }));

import { exec } from '../../shared/exec';
import { resolveMonochange } from '../../shared/monochange-cli';

import type { CiInputs } from './inputs';

const mockCore = vi.mocked(core);
const mockExec = vi.mocked(exec);
const mockResolve = vi.mocked(resolveMonochange);

const DECIDE_STDOUT = [
  'decisions={"docs":false,"test-windows":true}',
  'affected-packages=["gallery","ws_support"]',
  'run-all=false',
].join('\n');

function setInputs(values: Record<string, string>): void {
  mockCore.getInput.mockImplementation((name) => values[name] ?? '');
}

function baseInputs(overrides: Partial<CiInputs> = {}): CiInputs {
  return {
    apiKey: '',
    apiUrl: '',
    authToken: '',
    base: '',
    cloudflareAccountId: '',
    decisions: '',
    head: '',
    mode: 'decide',
    model: '',
    needs: '',
    onError: 'run-all',
    provider: '',
    repoId: '',
    requireAuth: false,
    setupMonochange: 'true',
    workflow: '',
    workingDirectory: '.',
    ...overrides,
  };
}

function baseContext(overrides: Partial<CiGitHubContext> = {}): CiGitHubContext {
  return {
    before: '',
    branch: 'feat/test',
    commit: 'sha-123',
    commitMessage: '',
    defaultBranch: 'main',
    eventName: 'pull_request',
    labels: [],
    ref: 'refs/pull/42/merge',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setInputs({});
  githubMock.context.eventName = 'pull_request';
  githubMock.context.payload = {};
  githubMock.context.ref = 'refs/pull/42/merge';
  githubMock.context.sha = 'sha-123';
  mockResolve.mockResolvedValue({
    command: 'monochange',
    source: 'existing-monochange',
    version: '1.0.0',
  });
  mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'ok' });
});

describe('runCi decide', () => {
  it('runs the CLI with the full GitHub and provider context and republishes its outputs', async () => {
    setInputs({
      'api-key': 'provider-key',
      'api-url': 'https://provider.test/v1',
      'auth-token': 'ci-token',
      'cloudflare-account-id': 'account-1',
      head: 'HEAD~2',
      mode: 'decide',
      model: 'model-1',
      'on-error': 'run-all',
      provider: 'opencode-go',
      'repo-id': 'monochange/actions',
      'require-auth': 'true',
      'setup-monochange': 'pnpm exec monochange',
      'working-directory': 'packages/app',
    });
    githubMock.context.payload = {
      pull_request: { head: { ref: 'feat/test' }, labels: [{ name: 'ci:full' }, { name: 'docs' }] },
    };
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: DECIDE_STDOUT });

    await runCi();

    expect(mockResolve).toHaveBeenCalledWith('pnpm exec monochange');
    expect(mockCore.setSecret).toHaveBeenCalledWith('provider-key');
    expect(mockCore.setSecret).toHaveBeenCalledWith('ci-token');
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'ci',
        'decide',
        '--format',
        'github-outputs',
        '--on-error',
        'run-all',
        '--base',
        'HEAD^1',
        '--head',
        'HEAD~2',
        '--event',
        'pull_request',
        '--branch',
        'feat/test',
        '--ref',
        'refs/pull/42/merge',
        '--commit',
        'sha-123',
        '--labels',
        'ci:full',
        '--labels',
        'docs',
        '--provider',
        'opencode-go',
        '--model',
        'model-1',
        '--api-key',
        'provider-key',
        '--api-url',
        'https://provider.test/v1',
        '--account-id',
        'account-1',
        '--token',
        'ci-token',
        '--require-auth',
        '--repo-id',
        'monochange/actions',
      ],
      { cwd: 'packages/app' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'decisions',
      '{"docs":false,"test-windows":true}',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'affected-packages',
      '["gallery","ws_support"]',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('run-all', 'false');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('uses the push before SHA and head commit message for the diff and marker context', async () => {
    setInputs({ mode: 'decide' });
    githubMock.context.eventName = 'push';
    githubMock.context.ref = 'refs/heads/main';
    githubMock.context.payload = {
      before: 'base-sha',
      head_commit: { message: 'feat: [ci:full]' },
    };
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: DECIDE_STDOUT });

    await runCi();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      expect.arrayContaining([
        '--base',
        'base-sha',
        '--head',
        'HEAD',
        '--branch',
        'main',
        '--commit-message',
        'feat: [ci:full]',
      ]),
      { cwd: '.' },
    );
  });

  it('fails open with run-all outputs when the CLI exits non-zero', async () => {
    setInputs({ mode: 'decide', 'on-error': 'run-all' });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: 'provider exploded', stdout: '' });

    await runCi();

    expect(mockCore.error).toHaveBeenCalledWith(expect.stringContaining('provider exploded'));
    expect(mockCore.setOutput).toHaveBeenCalledWith('decisions', '{}');
    expect(mockCore.setOutput).toHaveBeenCalledWith('affected-packages', '[]');
    expect(mockCore.setOutput).toHaveBeenCalledWith('run-all', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('fails open when the CLI exits zero with unparsable outputs', async () => {
    setInputs({ mode: 'decide' });
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'not an outputs block' });

    await runCi();

    expect(mockCore.error).toHaveBeenCalledWith(expect.stringContaining('not an outputs block'));
    expect(mockCore.setOutput).toHaveBeenCalledWith('run-all', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('fails open when the CLI cannot be spawned', async () => {
    setInputs({ mode: 'decide' });
    mockExec.mockRejectedValue(new Error('spawn monochange ENOENT'));

    await runCi();

    expect(mockCore.error).toHaveBeenCalledWith(expect.stringContaining('spawn monochange ENOENT'));
    expect(mockCore.setOutput).toHaveBeenCalledWith('decisions', '{}');
    expect(mockCore.setOutput).toHaveBeenCalledWith('run-all', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('stringifies a non-Error spawn failure', async () => {
    setInputs({ mode: 'decide' });
    mockExec.mockRejectedValue('permission denied');

    await runCi();

    expect(mockCore.error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    expect(mockCore.setOutput).toHaveBeenCalledWith('run-all', 'true');
  });

  it('fails the step when on-error is fail and the CLI cannot be spawned', async () => {
    setInputs({ mode: 'decide', 'on-error': 'fail' });
    mockExec.mockRejectedValue(new Error('spawn monochange ENOENT'));

    await expect(runCi()).rejects.toThrow('monochange ci decide failed: spawn monochange ENOENT');
  });

  it('fails the step when on-error is fail and the CLI exits non-zero', async () => {
    setInputs({ mode: 'decide', 'on-error': 'fail' });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: 'bad config', stdout: '' });

    await expect(runCi()).rejects.toThrow('monochange ci decide failed: bad config');
    expect(mockCore.error).not.toHaveBeenCalled();
  });

  it.each([
    ['missing decisions', 'affected-packages=[]\nrun-all=false'],
    ['missing affected-packages', 'decisions={}\nrun-all=false'],
    ['missing run-all', 'decisions={}\naffected-packages=[]'],
    ['non-object decisions', 'decisions=[]\naffected-packages=[]\nrun-all=false'],
    ['non-boolean decision values', 'decisions={"docs":1}\naffected-packages=[]\nrun-all=false'],
    ['non-array affected-packages', 'decisions={}\naffected-packages={}\nrun-all=false'],
    ['non-string affected-package entries', 'decisions={}\naffected-packages=[1]\nrun-all=false'],
    ['invalid run-all', 'decisions={}\naffected-packages=[]\nrun-all=maybe'],
    ['invalid JSON', 'decisions={not-json\naffected-packages=[]\nrun-all=false'],
  ])('rejects unparsable CLI output: %s', async (_name, stdout) => {
    setInputs({ mode: 'decide', 'on-error': 'fail' });
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout });

    await expect(runCi()).rejects.toThrow('monochange ci decide failed');
  });
});

describe('runCi verify', () => {
  const needs = {
    'cancelled-job': { result: 'cancelled' },
    docs: { outputs: {}, result: 'failure' },
    gate: { outputs: { decisions: '{}' }, result: 'success' },
    'not-gated': { result: 'success' },
    'skipped-job': { outputs: {}, result: 'skipped' },
    'test-windows': { outputs: {}, result: 'success' },
    'unknown-job': { result: 'neutral' },
  };
  const decisions = {
    'cancelled-job': true,
    docs: false,
    'skipped-job': false,
    'test-windows': true,
    'unknown-job': true,
  };

  it('verifies every gated job and skips cancelled, unknown, and untracked jobs', async () => {
    setInputs({
      'auth-token': 'ci-token',
      decisions: JSON.stringify(decisions),
      mode: 'verify',
      needs: JSON.stringify(needs),
      'repo-id': 'monochange/actions',
      'require-auth': 'true',
      'working-directory': 'packages/app',
    });
    githubMock.context.eventName = 'push';
    githubMock.context.ref = 'refs/heads/main';
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'recorded' });

    await runCi();

    expect(mockCore.setSecret).toHaveBeenCalledWith('ci-token');
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      'monochange',
      [
        'ci',
        'verify',
        '--job',
        'docs',
        '--conclusion',
        'failure',
        '--prior-decision',
        'n',
        '--commit',
        'sha-123',
        '--branch',
        'main',
        '--token',
        'ci-token',
        '--require-auth',
        '--repo-id',
        'monochange/actions',
      ],
      { cwd: 'packages/app' },
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      'monochange',
      expect.arrayContaining(['--job', 'skipped-job', '--conclusion', 'skipped']),
      { cwd: 'packages/app' },
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      3,
      'monochange',
      expect.arrayContaining(['--job', 'test-windows', '--conclusion', 'success']),
      { cwd: 'packages/app' },
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping verify for `cancelled-job`'),
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping verify for `unknown-job`'),
    );
    expect(mockCore.info).toHaveBeenCalledWith('recorded');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('fails the step when a verify command exits non-zero', async () => {
    setInputs({
      decisions: JSON.stringify({ 'test-windows': true }),
      mode: 'verify',
      needs: JSON.stringify({ 'test-windows': { result: 'success' } }),
    });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: 'memory is locked', stdout: '' });

    await expect(runCi()).rejects.toThrow(
      'monochange ci verify failed for `test-windows`: memory is locked',
    );
  });

  it('does nothing when the gate produced no decisions', async () => {
    setInputs({
      decisions: '{}',
      mode: 'verify',
      needs: JSON.stringify({ 'test-windows': { result: 'success' } }),
    });

    await runCi();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it.each([
    ['needs is not an object', '[]', '{}'],
    ['needs entry is not an object', '{"job":"success"}', '{}'],
    ['needs entry has no result', '{"job":{}}', '{}'],
    ['decisions is not an object', '{}', '[]'],
    ['decision is not a boolean', '{}', '{"job":"yes"}'],
  ])('rejects malformed verify inputs: %s', async (_name, needsInput, decisionsInput) => {
    setInputs({ decisions: decisionsInput, mode: 'verify', needs: needsInput });

    await expect(runCi()).rejects.toThrow(/Input `(?:needs|decisions)`/);
  });
});

describe('runCi check', () => {
  it('scans each comma- or newline-separated workflow path', async () => {
    setInputs({
      mode: 'check',
      workflow: '.github/workflows/ci.yml,\n.github/workflows/release.yml',
      'working-directory': 'packages/app',
    });
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'ci configuration valid' });

    await runCi();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'ci',
        'check',
        '--workflow',
        '.github/workflows/ci.yml',
        '--workflow',
        '.github/workflows/release.yml',
      ],
      { cwd: 'packages/app' },
    );
    expect(mockCore.info).toHaveBeenCalledWith('ci configuration valid');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('validates the configuration without workflow paths', async () => {
    setInputs({ mode: 'check' });

    await runCi();

    expect(mockExec).toHaveBeenCalledWith('monochange', ['ci', 'check'], { cwd: '.' });
  });

  it('fails the step with stderr when the check exits non-zero', async () => {
    setInputs({ mode: 'check' });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: 'ci check found 2 problems', stdout: '' });

    await expect(runCi()).rejects.toThrow('monochange ci check failed: ci check found 2 problems');
  });

  it('falls back to stdout and then the exit code for a check failure', async () => {
    setInputs({ mode: 'check' });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: 'stdout problem' });

    await expect(runCi()).rejects.toThrow('monochange ci check failed: stdout problem');

    mockExec.mockResolvedValue({ exitCode: 2, stderr: '', stdout: '' });

    await expect(runCi()).rejects.toThrow('monochange ci check failed: exit code 2');
  });
});

describe('runCi inputs and secrets', () => {
  it('defaults mode, setup, working directory, and on-error', async () => {
    await runCi();

    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      expect.arrayContaining([
        'ci',
        'decide',
        '--on-error',
        'run-all',
        '--base',
        'HEAD^1',
        '--head',
        'HEAD',
      ]),
      { cwd: '.' },
    );
    expect(mockCore.setSecret).not.toHaveBeenCalled();
  });

  it('accepts an explicit fail on-error and a custom working directory', async () => {
    setInputs({ mode: 'decide', 'on-error': 'fail', 'working-directory': 'repo' });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: 'boom', stdout: '' });

    await expect(runCi()).rejects.toThrow('monochange ci decide failed: boom');
    expect(mockExec).toHaveBeenCalledWith('monochange', expect.any(Array), { cwd: 'repo' });
  });

  it.each(['publish', 'DECIDE !'])('rejects an unsupported mode: %s', async (mode) => {
    setInputs({ mode });

    await expect(runCi()).rejects.toThrow('Input `mode` must be decide, verify, or check');
  });

  it('rejects an unsupported on-error value', async () => {
    setInputs({ mode: 'decide', 'on-error': 'ignore' });

    await expect(runCi()).rejects.toThrow('Input `on-error` must be fail or run-all');
  });
});

describe('buildDecideArgs', () => {
  it('includes provider and auth flags only when they are set', () => {
    const args = buildDecideArgs(baseInputs({ onError: 'fail' }), baseContext());

    expect(args).toEqual([
      'ci',
      'decide',
      '--format',
      'github-outputs',
      '--on-error',
      'fail',
      '--base',
      'HEAD^1',
      '--head',
      'HEAD',
      '--event',
      'pull_request',
      '--branch',
      'feat/test',
      '--ref',
      'refs/pull/42/merge',
      '--commit',
      'sha-123',
    ]);
  });

  it('uses an explicit base and head when supplied', () => {
    const args = buildDecideArgs(
      baseInputs({ base: 'origin/main', head: 'feature' }),
      baseContext({ eventName: 'schedule' }),
    );

    expect(args).toContain('origin/main');
    expect(args).toContain('feature');
  });
});

describe('resolveBase', () => {
  it.each([
    {
      base: 'origin/release',
      context: baseContext(),
      expected: 'origin/release',
      name: 'explicit base wins',
    },
    {
      base: '',
      context: baseContext(),
      expected: 'HEAD^1',
      name: 'pull_request uses the merge first parent',
    },
    {
      base: '',
      context: baseContext({ before: 'before-sha', eventName: 'push' }),
      expected: 'before-sha',
      name: 'push uses the event before SHA',
    },
    {
      base: '',
      context: baseContext({
        before: '0000000000000000',
        defaultBranch: 'trunk',
        eventName: 'push',
      }),
      expected: 'origin/trunk',
      name: 'push with an all-zero before falls back to the default branch',
    },
    {
      base: '',
      context: baseContext({ before: '', defaultBranch: 'trunk', eventName: 'push' }),
      expected: 'origin/trunk',
      name: 'push with an empty before falls back to the default branch',
    },
    {
      base: '',
      context: baseContext({ defaultBranch: 'trunk', eventName: 'workflow_dispatch' }),
      expected: 'origin/trunk',
      name: 'other events compare against the default branch',
    },
  ])('$name', ({ base, context, expected }) => {
    expect(resolveBase(base, context)).toBe(expected);
  });
});

describe('buildVerifyArgs', () => {
  it('omits optional context that is not available', () => {
    expect(
      buildVerifyArgs({
        conclusion: 'success',
        context: baseContext({ branch: '', commit: '' }),
        inputs: baseInputs({ mode: 'verify' }),
        jobId: 'docs',
        priorDecision: false,
      }),
    ).toEqual([
      'ci',
      'verify',
      '--job',
      'docs',
      '--conclusion',
      'success',
      '--prior-decision',
      'n',
    ]);
  });

  it('normalises conclusions case-insensitively through the CLI mapping', async () => {
    setInputs({
      decisions: JSON.stringify({ 'test-windows': true }),
      mode: 'verify',
      needs: JSON.stringify({ 'test-windows': { result: 'SUCCESS ' } }),
    });

    await runCi();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      expect.arrayContaining(['--conclusion', 'success', '--prior-decision', 'y']),
      { cwd: '.' },
    );
  });
});

describe('parseWorkflows', () => {
  it('splits, trims, and drops empty entries', () => {
    expect(parseWorkflows(' a.yml,\n b.yml ,,\n\nc.yml ')).toEqual(['a.yml', 'b.yml', 'c.yml']);
    expect(parseWorkflows('')).toEqual([]);
  });
});

describe('readGitHubContext', () => {
  it('reads pull request head, labels, and repository context', () => {
    githubMock.context.payload = {
      before: '',
      pull_request: { head: { ref: 'feat/context' }, labels: [{ name: 'ci:full' }, 'not-a-label'] },
    };

    expect(readGitHubContext()).toEqual({
      before: '',
      branch: 'feat/context',
      commit: 'sha-123',
      commitMessage: '',
      defaultBranch: 'main',
      eventName: 'pull_request',
      labels: ['ci:full'],
      ref: 'refs/pull/42/merge',
    });
  });

  it('reads push context, the head commit message, and the default branch', () => {
    githubMock.context.eventName = 'push';
    githubMock.context.ref = 'refs/heads/main';
    githubMock.context.payload = {
      before: 'before-sha',
      head_commit: { message: 'feat: [ci:full]' },
      repository: { default_branch: 'trunk' },
    };

    expect(readGitHubContext()).toEqual({
      before: 'before-sha',
      branch: 'main',
      commit: 'sha-123',
      commitMessage: 'feat: [ci:full]',
      defaultBranch: 'trunk',
      eventName: 'push',
      labels: [],
      ref: 'refs/heads/main',
    });
  });

  it('falls back to the ref when a pull request has no head branch', () => {
    githubMock.context.payload = { pull_request: { labels: [] } };

    expect(readGitHubContext().branch).toBe('refs/pull/42/merge');
  });

  it('strips tag refs and leaves other refs intact', () => {
    githubMock.context.ref = 'refs/tags/v1.2.3';
    expect(readGitHubContext().branch).toBe('v1.2.3');

    githubMock.context.ref = 'refs/pull/42/merge';
    expect(readGitHubContext().branch).toBe('refs/pull/42/merge');
  });

  it('tolerates an empty webhook payload and malformed fields', () => {
    githubMock.context.eventName = '';
    githubMock.context.ref = '';
    githubMock.context.sha = '';
    githubMock.context.payload = null;

    expect(readGitHubContext()).toEqual({
      before: '',
      branch: '',
      commit: '',
      commitMessage: '',
      defaultBranch: 'main',
      eventName: '',
      labels: [],
      ref: '',
    });
  });

  it('ignores labels and fields with the wrong shape', () => {
    githubMock.context.payload = {
      head_commit: 'not-a-record',
      pull_request: {
        head: { ref: '' },
        labels: [5, { name: '' }, { name: 'docs' }],
      },
      repository: { default_branch: 7 },
    };

    expect(readGitHubContext()).toEqual({
      before: '',
      branch: 'refs/pull/42/merge',
      commit: 'sha-123',
      commitMessage: '',
      defaultBranch: 'main',
      eventName: 'pull_request',
      labels: ['docs'],
      ref: 'refs/pull/42/merge',
    });
  });
});
