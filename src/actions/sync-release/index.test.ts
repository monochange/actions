import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runSyncRelease } from './index';

vi.mock('@actions/core');

vi.mock('../../shared/exec', () => ({
  execRequired: vi.fn(),
}));

vi.mock('../../shared/json', () => ({
  parseMixedOutput: vi.fn(),
}));

vi.mock('../../shared/monochange-cli', () => ({
  resolveMonochange: vi.fn(),
}));

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockExec = vi.mocked(execRequired);
const mockResolve = vi.mocked(resolveMonochange);
const mockParse = vi.mocked(parseMixedOutput);
const mockCore = vi.mocked(core);

describe('runSyncRelease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '0.23.0',
    });
    mockExec.mockResolvedValue(
      '{"sync":{"status":"completed","synced_tags":["v0.22.0"]},"release_request":{"head_branch":"monochange/sync-release"}}',
    );
    mockParse.mockReturnValue({
      release_request: {
        head_branch: 'monochange/sync-release',
      },
      release_request_result: 'monochange/demo #99 (created) via github',
      sync: {
        status: 'completed',
        synced_tags: ['v0.22.0'],
      },
    });
  });

  it('runs a single open-sync-request invocation by default and parses wrapped CLI output', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'from') return 'v0.22.0';
      if (name === 'mode') return 'merge_pr';
      if (name === 'github-token') return 'tok';
      return '';
    });

    await runSyncRelease();

    expect(mockCore.setSecret).toHaveBeenCalledWith('tok');
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'step',
        'open-sync-request',
        '--format',
        'json',
        '--from',
        'v0.22.0',
        '--mode',
        'merge_pr',
        '--backend',
        'local',
      ],
      expect.objectContaining({
        cwd: '.',
        env: expect.objectContaining({ GITHUB_TOKEN: 'tok' }),
      }),
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('synced-tags', '["v0.22.0"]');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'json',
      expect.stringContaining('"release_request_result"'),
    );
  });

  it('runs standalone sync-release only when open-request is false', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'open-request') return 'false';
      if (name === 'from') return 'v0.22.0';
      if (name === 'mode') return 'bookkeeping_only';
      return '';
    });
    mockParse.mockReturnValue({
      status: 'completed',
      synced_tags: ['v0.22.0', 42],
    });

    await runSyncRelease();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'step',
        'sync-release',
        '--format',
        'json',
        '--from',
        'v0.22.0',
        '--mode',
        'bookkeeping_only',
      ],
      { cwd: '.' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('synced-tags', '["v0.22.0"]');
  });

  it('reports skipped when sync mode is none', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'mode') return 'none';
      return '';
    });
    mockParse.mockReturnValue({
      mode: 'none',
      status: 'skipped',
      synced_tags: [],
    });

    await runSyncRelease();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-sync-request', '--format', 'json', '--mode', 'none', '--backend', 'local'],
      { cwd: '.' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
    expect(mockCore.setOutput).toHaveBeenCalledWith('synced-tags', '[]');
  });

  it('reports skipped when already up to date', async () => {
    mockParse.mockReturnValue({
      status: 'up_to_date',
      synced_tags: [],
    });

    await runSyncRelease();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
  });

  it('passes hosted url and dry-run flags to a single open-sync-request invocation', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'backend') return 'hosted';
      if (name === 'hosted-url') return 'https://hosted.example';
      if (name === 'dry-run') return 'true';
      if (name === 'debug') return 'true';
      return '';
    });
    mockParse.mockReturnValue({
      release_request_result: 'dry-run',
      sync: {
        status: 'dry_run',
        synced_tags: ['v0.22.0'],
      },
    });

    await runSyncRelease();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-sync-request', '--format', 'json', '--backend', 'hosted', '--dry-run'],
      expect.objectContaining({
        cwd: '.',
        env: expect.objectContaining({ MONOCHANGE_HOSTED_URL: 'https://hosted.example' }),
      }),
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
    expect(mockCore.setOutput).toHaveBeenCalledWith('synced-tags', '["v0.22.0"]');
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('[redacted]'));
  });

  it('handles dry_run status from CLI output and non-object parsed output cleanly', async () => {
    mockParse.mockReturnValue({
      status: 'dry_run',
    });

    await runSyncRelease();

    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
    expect(mockCore.setOutput).toHaveBeenCalledWith('synced-tags', '[]');

    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '0.23.0',
    });
    mockExec.mockResolvedValue('plain text output');
    mockParse.mockReturnValue(undefined);

    await runSyncRelease();

    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('synced-tags', '[]');
    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('rejects invalid mode and backend values before running the CLI', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'mode') return 'decide';
      return '';
    });

    await expect(runSyncRelease()).rejects.toThrow(
      'Input `mode` for sync-release must be one of semantic_pr, bookkeeping_only, merge_pr, or none. Received `decide`.',
    );
    expect(mockResolve).not.toHaveBeenCalled();

    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'backend') return 'remote';
      return '';
    });

    await expect(runSyncRelease()).rejects.toThrow(
      'Input `backend` must be local or hosted. Received `remote`.',
    );
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
