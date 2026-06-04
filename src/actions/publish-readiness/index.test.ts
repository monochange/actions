import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runPublishReadiness } from './index';

vi.mock('@actions/core');
vi.mock('../../shared/exec', () => ({ exec: vi.fn(), execRequired: vi.fn() }));
vi.mock('../../shared/json', () => ({ parseMixedOutput: vi.fn() }));
vi.mock('../../shared/monochange-cli', () => ({ resolveMonochange: vi.fn() }));

import { exec, execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockCore = vi.mocked(core);
const mockExec = vi.mocked(exec);
const mockExecRequired = vi.mocked(execRequired);
const mockParse = vi.mocked(parseMixedOutput);
const mockResolve = vi.mocked(resolveMonochange);

describe('runPublishReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '{"id":"rel_1"}', stderr: '' });
    mockExecRequired.mockResolvedValue('{"ready":true}');
    mockParse.mockReturnValue({ ready: true });
  });

  it('checks release record before writing publish readiness', async () => {
    await runPublishReadiness();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'release-record', '--from', 'HEAD', '--format', 'json'],
      { cwd: '.', ignoreReturnCode: true },
    );
    expect(mockExecRequired).toHaveBeenCalledWith(
      'monochange',
      [
        'step',
        'publish-readiness',
        '--from',
        'HEAD',
        '--output',
        '.monochange/publish-readiness.json',
        '--format',
        'json',
      ],
      { cwd: '.' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('ready', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'output-path',
      '.monochange/publish-readiness.json',
    );
  });

  it('skips when no release record exists', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no release record found' });

    await runPublishReadiness();

    expect(mockExecRequired).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
    expect(mockCore.setOutput).toHaveBeenCalledWith('has-release-record', 'false');
  });

  it('outputs null json when publish-readiness output is not JSON', async () => {
    mockParse.mockReturnValue(undefined);

    await runPublishReadiness();

    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('fails on unexpected release-record errors', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'git failed' });

    await expect(runPublishReadiness()).rejects.toThrow('git failed');
  });

  it('uses fallback message for unexpected release-record errors with empty output', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    await expect(runPublishReadiness()).rejects.toThrow(
      'monochange step release-record failed for HEAD',
    );
  });

  it('supports dry-run after a release record is found', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'dry-run' ? 'true' : ''));

    await runPublishReadiness();

    expect(mockExecRequired).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
    expect(mockCore.setOutput).toHaveBeenCalledWith('has-release-record', 'true');
  });
});
