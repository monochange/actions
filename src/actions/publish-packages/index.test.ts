import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runPublishPackages } from './index';

vi.mock('@actions/core');
vi.mock('../../shared/exec', () => ({ execRequired: vi.fn() }));
vi.mock('../../shared/json', () => ({ parseMixedOutput: vi.fn() }));
vi.mock('../../shared/monochange-cli', () => ({ resolveMonochange: vi.fn() }));

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockCore = vi.mocked(core);
const mockExec = vi.mocked(execRequired);
const mockParse = vi.mocked(parseMixedOutput);
const mockResolve = vi.mocked(resolveMonochange);

describe('runPublishPackages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"published":[]}');
    mockParse.mockReturnValue({ published: [] });
  });

  it('runs publish-packages with default output', async () => {
    await runPublishPackages();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'step',
        'publish-packages',
        '--output',
        '.monochange/publish-result.json',
        '--format',
        'json',
      ],
      { cwd: '.' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'output-path',
      '.monochange/publish-result.json',
    );
  });

  it('outputs null json when publish output is not JSON', async () => {
    mockParse.mockReturnValue(undefined);

    await runPublishPackages();

    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('passes resume and all inputs', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'resume') return 'previous.json';
      if (name === 'all') return 'true';
      if (name === 'output') return 'result.json';
      return '';
    });

    await runPublishPackages();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'step',
        'publish-packages',
        '--output',
        'result.json',
        '--format',
        'json',
        '--resume',
        'previous.json',
        '--all',
      ],
      { cwd: '.' },
    );
  });

  it('supports dry-run without running command', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'dry-run' ? 'true' : ''));

    await runPublishPackages();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
  });
});
