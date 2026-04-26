import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runPublishPlan } from './index';

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

describe('runPublishPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'mc',
      source: 'existing-mc',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"packages":[]}');
    mockParse.mockReturnValue({ packages: [], fitsSingleWindow: true });
  });

  it('runs publish-plan with defaults', async () => {
    await runPublishPlan();

    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith('mc', [
      'publish-plan',
      '--format',
      'json',
      '--mode',
      'full',
    ]);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('passes package filters', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'package') return 'pkg-a, pkg-b';
      return '';
    });

    await runPublishPlan();

    expect(mockExec).toHaveBeenCalledWith(
      'mc',
      expect.arrayContaining([
        'publish-plan',
        '--format',
        'json',
        '--mode',
        'full',
        '--package',
        'pkg-a',
        '--package',
        'pkg-b',
      ]),
    );
  });

  it('sets fits-single-window output in single-window mode', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'mode') return 'single-window';
      return '';
    });

    await runPublishPlan();

    expect(mockCore.setOutput).toHaveBeenCalledWith('fits-single-window', 'true');
  });

  it('throws when execRequired fails', async () => {
    mockExec.mockRejectedValue(new Error('mc publish-plan failed'));

    await expect(runPublishPlan()).rejects.toThrow('mc publish-plan failed');
  });
});
