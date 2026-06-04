import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runReleasePreview } from './index';

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

describe('runReleasePreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"preview":true}');
    mockParse.mockReturnValue({ preview: true });
  });

  it('runs prepare-release dry-run with diff by default', async () => {
    await runReleasePreview();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'prepare-release', '--dry-run', '--format', 'json', '--diff'],
      { cwd: '.' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('json', '{"preview":true}');
  });

  it('outputs null json when preview output is not JSON', async () => {
    mockParse.mockReturnValue(undefined);

    await runReleasePreview();

    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('can omit diff and use a custom working directory', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'diff') return 'false';
      if (name === 'working-directory') return 'packages/a';
      return '';
    });

    await runReleasePreview();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'prepare-release', '--dry-run', '--format', 'json'],
      { cwd: 'packages/a' },
    );
  });
});
