import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runCheck } from './index';

vi.mock('@actions/core');
vi.mock('../../shared/exec', () => ({ execRequired: vi.fn() }));
vi.mock('../../shared/monochange-cli', () => ({ resolveMonochange: vi.fn() }));

import { execRequired } from '../../shared/exec';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockCore = vi.mocked(core);
const mockExec = vi.mocked(execRequired);
const mockResolve = vi.mocked(resolveMonochange);

describe('runCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('ok');
  });

  it('runs monochange check with defaults', async () => {
    await runCheck();

    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith('monochange', ['check'], { cwd: '.' });
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('summary', 'ok');
  });

  it('passes format and working directory', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'format') return 'json';
      if (name === 'working-directory') return 'packages/a';
      return '';
    });

    await runCheck();

    expect(mockExec).toHaveBeenCalledWith('monochange', ['check', '--format', 'json'], {
      cwd: 'packages/a',
    });
  });
});
