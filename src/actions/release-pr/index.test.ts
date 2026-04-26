import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runReleasePr } from './index';

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

describe('runReleasePr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'mc',
      source: 'existing-mc',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"number":42}');
    mockParse.mockReturnValue({
      baseBranch: 'main',
      headBranch: 'release/1.0',
      number: 42,
      url: 'https://github.com/monochange/actions/pull/42',
    });
  });

  it('runs release-pr and sets outputs', async () => {
    await runReleasePr();
    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith('mc', ['release-pr', '--format', 'json'], {
      cwd: '.',
    });
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '42');
  });

  it('logs debug info', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'debug') return 'true';
      return '';
    });

    await runReleasePr();

    expect(mockCore.info).toHaveBeenCalled();
  });

  it('outputs empty release-request-number when parsed number is not a number or string', async () => {
    mockParse.mockReturnValue({ number: null });

    await runReleasePr();

    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '');
  });

  it('outputs release-request-number when parsed number is a string', async () => {
    mockParse.mockReturnValue({ number: '42' });

    await runReleasePr();

    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '42');
  });

  it('sets GITHUB_TOKEN when provided', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'secret-token';
      return '';
    });

    await runReleasePr();

    expect(mockCore.exportVariable).toHaveBeenCalledWith('GITHUB_TOKEN', 'secret-token');
  });

  it('outputs dry-run values without running command', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'dry-run') return 'true';
      return '';
    });

    await runReleasePr();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
  });

  it('outputs empty values when parsed is undefined', async () => {
    mockParse.mockReturnValue(undefined);

    await runReleasePr();

    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('head-branch', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('base-branch', '');
  });

  it('throws when execRequired fails', async () => {
    mockExec.mockRejectedValue(new Error('mc release-pr failed'));

    await expect(runReleasePr()).rejects.toThrow('mc release-pr failed');
  });
});
