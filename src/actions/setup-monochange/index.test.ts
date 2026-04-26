import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runSetupMonochange } from './';

vi.mock('@actions/core');

vi.mock('../../shared/monochange-cli', () => ({
  resolveMonochange: vi.fn(),
}));

import { resolveMonochange } from '../../shared/monochange-cli';

const mockResolve = vi.mocked(resolveMonochange);
const mockCore = vi.mocked(core);

describe('runSetupMonochange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
  });

  it('resolves monochange with default input and sets outputs', async () => {
    mockResolve.mockResolvedValue({
      command: 'mc',
      source: 'existing-mc',
      version: '1.2.3',
    });

    await runSetupMonochange();

    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('command', 'mc');
    expect(mockCore.setOutput).toHaveBeenCalledWith('version', '1.2.3');
    expect(mockCore.setOutput).toHaveBeenCalledWith('source', 'existing-mc');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('logs debug info', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'debug') return 'true';
      return '';
    });
    mockResolve.mockResolvedValue({
      command: 'mc',
      source: 'existing-mc',
      version: '1.2.3',
    });

    await runSetupMonochange();

    expect(mockCore.info).toHaveBeenCalled();
  });

  it('passes custom setup-monochange input', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'setup-monochange') return '/opt/bin/mc';
      return '';
    });
    mockResolve.mockResolvedValue({
      command: '/opt/bin/mc',
      source: 'custom-command',
      version: '2.0.0',
    });

    await runSetupMonochange();

    expect(mockResolve).toHaveBeenCalledWith('/opt/bin/mc');
    expect(mockCore.setOutput).toHaveBeenCalledWith('command', '/opt/bin/mc');
  });

  it('throws when resolveMonochange fails', async () => {
    mockResolve.mockRejectedValue(new Error('not found'));

    await expect(runSetupMonochange()).rejects.toThrow('not found');
  });
});
