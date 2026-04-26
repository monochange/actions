import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runPostMergeRelease } from './index';

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

describe('runPostMergeRelease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'mc',
      source: 'existing-mc',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('');
    mockParse.mockReturnValue({ version: '1.0.0' });
  });

  it('detects release record, tags, and publishes', async () => {
    mockParse.mockReturnValue({ version: '1.0.0' });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledWith('mc', [
      'release-record',
      '--from',
      'HEAD',
      '--format',
      'json',
    ]);
    expect(mockExec).toHaveBeenCalledWith('mc', ['tag-release', '--from', 'HEAD']);
    expect(mockExec).toHaveBeenCalledWith('mc', ['publish-release']);
    expect(mockCore.setOutput).toHaveBeenCalledWith('tagged', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('published', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('logs debug info', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'debug') return 'true';
      return '';
    });
    mockParse.mockReturnValue({ version: '1.0.0' });

    await runPostMergeRelease();

    expect(mockCore.info).toHaveBeenCalled();
  });

  it('skips when no release record found', async () => {
    mockParse.mockReturnValue(undefined);

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledTimes(1); // only release-record
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
  });

  it('sets published=false when publish-release fails', async () => {
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'publish-release') {
        throw new Error('publish failed');
      }

      return '';
    });

    await runPostMergeRelease();

    expect(mockCore.setOutput).toHaveBeenCalledWith('published', 'false');
    expect(mockCore.warning).toHaveBeenCalledWith('publish-release failed: publish failed');
  });

  it('uses target-branch when provided', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'target-branch') return 'release';
      return '';
    });

    await runPostMergeRelease();

    expect(mockExec).toHaveBeenCalledWith('mc', [
      'release-record',
      '--from',
      'HEAD',
      '--format',
      'json',
      '--branch',
      'release',
    ]);
    expect(mockExec).toHaveBeenCalledWith('mc', [
      'tag-release',
      '--from',
      'HEAD',
      '--branch',
      'release',
    ]);
  });

  it('handles non-Error thrown during publish-release', async () => {
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'publish-release') {
        return Promise.reject('plain string error');
      }
      return '';
    });

    await runPostMergeRelease();

    expect(mockCore.setOutput).toHaveBeenCalledWith('published', 'false');
    expect(mockCore.warning).toHaveBeenCalledWith('publish-release failed: plain string error');
  });

  it('outputs dry-run values without running commands', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'dry-run') return 'true';
      return '';
    });

    await runPostMergeRelease();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
  });
});
