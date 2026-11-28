import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { runPostMergeRelease } from './index';

vi.mock('@actions/core');

vi.mock('@actions/github', () => ({
  context: {
    payload: {},
  },
}));

vi.mock('../../shared/exec', () => ({
  exec: vi.fn(),
  execRequired: vi.fn(),
}));

vi.mock('../../shared/json', () => ({
  parseMixedOutput: vi.fn(),
}));

vi.mock('../../shared/monochange-cli', () => ({
  resolveMonochange: vi.fn(),
}));

import { exec, execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockExec = vi.mocked(execRequired);
const mockExecRaw = vi.mocked(exec);
const mockResolve = vi.mocked(resolveMonochange);
const mockParse = vi.mocked(parseMixedOutput);
const mockCore = vi.mocked(core);
const mockGithub = vi.mocked(github);

describe('runPostMergeRelease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockGithub.context, { payload: {} });
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('');
    mockExecRaw.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });
    mockParse.mockReturnValue({ version: '1.0.0' });
  });

  it('detects release record, tags, and publishes', async () => {
    mockParse.mockReturnValue({ record: { version: '1.0.0' }, version: '1.0.0' });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledWith('monochange', [
      'step',
      'release-record',
      '--from',
      'HEAD',
      '--format',
      'json',
    ]);
    expect(mockExec).toHaveBeenCalledWith('monochange', ['step', 'tag-release', '--from', 'HEAD']);
    expect(mockExec).toHaveBeenCalledWith('monochange', ['step', 'publish-release']);
    expect(mockCore.setOutput).toHaveBeenCalledWith('tagged', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('published', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('logs debug info and redacts github-token', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'debug') return 'true';
      if (name === 'github-token') return 'secret-tok';
      return '';
    });
    mockParse.mockReturnValue({ version: '1.0.0' });

    await runPostMergeRelease();

    expect(mockCore.setSecret).toHaveBeenCalledWith('secret-tok');
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('[redacted]'));
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'publish-release'],
      expect.objectContaining({
        env: expect.objectContaining({ GITHUB_TOKEN: 'secret-tok' }),
      }),
    );

    vi.clearAllMocks();
    mockCore.getInput.mockImplementation((name: string) => (name === 'debug' ? 'true' : ''));
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('');
    mockParse.mockReturnValue({ version: '1.0.0' });

    await runPostMergeRelease();
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('"githubToken": ""'));
  });

  it('skips when no release record found', async () => {
    mockParse.mockReturnValue(undefined);

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledTimes(1); // only release-record
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
  });

  it('fails without running follow-on sync or open-next-cut when publish-release fails', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'sync-release') return 'true';
      if (name === 'open-next-cut') return 'true';
      return '';
    });
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'step' && args[1] === 'publish-release') {
        throw new Error('publish failed');
      }

      return '';
    });

    await expect(runPostMergeRelease()).rejects.toThrow('publish failed');

    expect(mockCore.setOutput).toHaveBeenCalledWith('published', 'false');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'failed');
    expect(mockCore.setOutput).not.toHaveBeenCalledWith('result', 'success');
    expect(mockCore.warning).toHaveBeenCalledWith('publish-release failed: publish failed');
    expect(mockExec).toHaveBeenCalledTimes(3); // release-record, tag-release, publish-release only
    expect(mockExec).not.toHaveBeenCalledWith('git', expect.anything());
    expect(mockExec).not.toHaveBeenCalledWith(
      'monochange',
      expect.arrayContaining(['open-sync-request']),
      expect.anything(),
    );
    expect(mockExec).not.toHaveBeenCalledWith(
      'monochange',
      expect.arrayContaining(['prepare-release']),
      expect.anything(),
    );
  });

  it('uses target-branch when provided', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'target-branch') return 'release';
      return '';
    });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledWith('monochange', [
      'step',
      'release-record',
      '--from',
      'HEAD',
      '--format',
      'json',
      '--branch',
      'release',
    ]);
    expect(mockExec).toHaveBeenCalledWith('monochange', [
      'step',
      'tag-release',
      '--from',
      'HEAD',
      '--branch',
      'release',
    ]);
  });

  it('handles non-Error thrown during publish-release and fails without follow-on steps', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'sync-release') return 'true';
      return '';
    });
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'step' && args[1] === 'publish-release') {
        return Promise.reject('plain string error');
      }
      return '';
    });

    await expect(runPostMergeRelease()).rejects.toThrow('plain string error');

    expect(mockCore.setOutput).toHaveBeenCalledWith('published', 'false');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'failed');
    expect(mockCore.warning).toHaveBeenCalledWith('publish-release failed: plain string error');
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it('outputs dry-run values without running commands', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'dry-run') return 'true';
      return '';
    });

    await runPostMergeRelease();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
    expect(mockCore.info).not.toHaveBeenCalledWith(expect.stringContaining('open-sync-request'));
    expect(mockCore.info).not.toHaveBeenCalledWith(expect.stringContaining('prepare-release'));

    vi.clearAllMocks();
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'dry-run') return 'true';
      if (name === 'sync-release') return 'true';
      if (name === 'open-next-cut') return 'true';
      return '';
    });
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });

    await runPostMergeRelease();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('open-sync-request'));
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('prepare-release'));
  });

  it('skips synced bookkeeping commits for both flat and ReleaseRecordDiscovery JSON shapes', async () => {
    mockParse.mockReturnValue({
      synced_from_commit: 'abc1234',
      version: '1.0.0',
    });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
    expect(mockCore.setOutput).toHaveBeenCalledWith('tagged', 'false');

    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('');
    mockParse.mockReturnValue({
      distance: 0,
      input_ref: 'HEAD',
      record: {
        synced_from_commit: 'def5678',
      },
    });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
    expect(mockCore.setOutput).toHaveBeenCalledWith('tagged', 'false');

    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('');
    mockParse.mockReturnValue(['non-record-array']);

    await runPostMergeRelease();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('runs single open-sync-request and open-next-cut from clean default-branch worktrees', async () => {
    Object.assign(mockGithub.context, {
      payload: {
        repository: {
          default_branch: 'trunk',
        },
      },
    });
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'base-branch') return 'main';
      if (name === 'sync-release') return 'true';
      if (name === 'open-next-cut') return 'true';
      return '';
    });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledWith('git', [
      'fetch',
      'origin',
      '+refs/heads/trunk:refs/remotes/origin/trunk',
    ]);

    const worktreeAddCalls = mockExec.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
    );
    expect(worktreeAddCalls).toHaveLength(2);
    expect(worktreeAddCalls[0]?.[1]).toEqual([
      'worktree',
      'add',
      '--force',
      '--detach',
      expect.stringContaining('monochange-post-merge-'),
      'refs/remotes/origin/trunk',
    ]);

    const syncWorktreeDir = worktreeAddCalls[0]?.[1]?.[4];
    const nextCutWorktreeDir = worktreeAddCalls[1]?.[1]?.[4];

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-sync-request', '--format', 'json'],
      { cwd: syncWorktreeDir },
    );
    expect(mockExec).not.toHaveBeenCalledWith(
      'monochange',
      ['step', 'sync-release', '--format', 'json'],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'prepare-release', '--format', 'json'],
      { cwd: nextCutWorktreeDir },
    );
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-release-request', '--format', 'json'],
      { cwd: nextCutWorktreeDir },
    );

    const worktreeRemoveCalls = mockExecRaw.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove',
    );
    expect(worktreeRemoveCalls).toHaveLength(2);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('resolves default branch via explicit base-branch, git origin/HEAD, and fallback main', async () => {
    // 1. Explicit non-main base-branch
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'base-branch') return 'develop';
      if (name === 'sync-release') return 'true';
      return '';
    });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledWith('git', [
      'fetch',
      'origin',
      '+refs/heads/develop:refs/remotes/origin/develop',
    ]);

    // 2. git symbolic-ref origin/HEAD
    vi.clearAllMocks();
    Object.assign(mockGithub.context, { payload: {} });
    mockCore.getInput.mockImplementation((name) => (name === 'sync-release' ? 'true' : ''));
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('');
    mockParse.mockReturnValue({ version: '1.0.0' });
    mockExecRaw.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'symbolic-ref') {
        return { exitCode: 0, stderr: '', stdout: 'origin/master\n' };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledWith('git', [
      'fetch',
      'origin',
      '+refs/heads/master:refs/remotes/origin/master',
    ]);

    // 3. git symbolic-ref returns unexpected ref -> fallback to main
    vi.clearAllMocks();
    Object.assign(mockGithub.context, { payload: {} });
    mockCore.getInput.mockImplementation((name) => (name === 'sync-release' ? 'true' : ''));
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('');
    mockParse.mockReturnValue({ version: '1.0.0' });
    mockExecRaw.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'HEAD\n' });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledWith('git', [
      'fetch',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
  });

  it('swallows open-next-cut no-changeset errors and still cleans up worktree', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'open-next-cut' ? 'true' : ''));
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'step' && args[1] === 'prepare-release') {
        throw new Error('no markdown changesets found');
      }
      return '';
    });

    await runPostMergeRelease();

    expect(mockCore.info).toHaveBeenCalledWith(
      'open-next-cut skipped or had no pending changesets: no markdown changesets found',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');

    // Also test non-Error rejection in open-next-cut
    vi.clearAllMocks();
    mockCore.getInput.mockImplementation((name) => (name === 'open-next-cut' ? 'true' : ''));
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockParse.mockReturnValue({ version: '1.0.0' });
    mockExecRaw.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'step' && args[1] === 'prepare-release') {
        return Promise.reject('no pending changesets');
      }
      return '';
    });

    await runPostMergeRelease();
    expect(mockCore.info).toHaveBeenCalledWith(
      'open-next-cut skipped or had no pending changesets: no pending changesets',
    );
  });
});
