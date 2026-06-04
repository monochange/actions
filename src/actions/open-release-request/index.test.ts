import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runOpenReleaseRequest } from './index';

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

describe('runOpenReleaseRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"number":42}');
    mockParse.mockReturnValue({
      baseBranch: 'main',
      headBranch: 'monochange/release/main',
      number: 42,
      url: 'https://github.com/monochange/actions/pull/42',
    });
  });

  it('runs open-release-request and exposes outputs', async () => {
    await runOpenReleaseRequest();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-release-request', '--format', 'json'],
      { cwd: '.' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '42');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'release-request-url',
      'https://github.com/monochange/actions/pull/42',
    );
  });

  it('exports GITHUB_TOKEN and supports dry-run', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'token';
      if (name === 'dry-run') return 'true';
      return '';
    });

    await runOpenReleaseRequest();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.exportVariable).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
  });

  it('outputs empty metadata when parsed output is not an object', async () => {
    mockParse.mockReturnValue(undefined);

    await runOpenReleaseRequest();

    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
    expect(mockCore.setOutput).toHaveBeenCalledWith('head-branch', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '');
  });

  it('outputs boolean metadata values as strings', async () => {
    mockParse.mockReturnValue({ baseBranch: true, headBranch: false, number: 7, url: 'url' });

    await runOpenReleaseRequest();

    expect(mockCore.setOutput).toHaveBeenCalledWith('base-branch', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('head-branch', 'false');
  });

  it('exports GITHUB_TOKEN before running when provided', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'github-token' ? 'token' : ''));

    await runOpenReleaseRequest();

    expect(mockCore.exportVariable).toHaveBeenCalledWith('GITHUB_TOKEN', 'token');
  });
});
