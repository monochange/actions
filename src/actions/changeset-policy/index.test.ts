import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runChangesetPolicy } from './';

vi.mock('@actions/core');
vi.mock('@actions/github', () => ({
  context: { repo: { owner: 'mono', repo: 'change' }, token: 'token' },
}));

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

describe('runChangesetPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'mc',
      source: 'existing-mc',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"packages":[]}');
    mockParse.mockReturnValue({ packages: [] });
  });

  it('resolves monochange and runs affected check', async () => {
    await runChangesetPolicy();

    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith('mc', ['affected', '--format', 'json', '--verify']);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('logs debug info', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'debug') return 'true';
      return '';
    });

    await runChangesetPolicy();

    expect(mockCore.info).toHaveBeenCalled();
  });

  it('passes optional inputs', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'changed-paths') return 'src/';
      if (name === 'labels') return 'bug,feature';
      if (name === 'skip-labels') return 'skip';
      return '';
    });

    await runChangesetPolicy();

    expect(mockExec).toHaveBeenCalledWith('mc', [
      'affected',
      '--format',
      'json',
      '--verify',
      '--paths',
      'src/',
      '--labels',
      'bug,feature',
      '--skip-labels',
      'skip',
    ]);
  });

  it('outputs dry-run without running command', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'dry-run') return 'true';
      return '';
    });

    await runChangesetPolicy();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
  });

  it('outputs null json when parsed is undefined', async () => {
    mockParse.mockReturnValue(undefined);

    await runChangesetPolicy();

    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('throws when execRequired fails', async () => {
    mockExec.mockRejectedValue(new Error('mc affected failed'));

    await expect(runChangesetPolicy()).rejects.toThrow('mc affected failed');
  });
});
