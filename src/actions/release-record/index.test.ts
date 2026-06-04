import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runReleaseRecord } from './index';

vi.mock('@actions/core');
vi.mock('../../shared/exec', () => ({ exec: vi.fn() }));
vi.mock('../../shared/json', () => ({ parseMixedOutput: vi.fn() }));
vi.mock('../../shared/monochange-cli', () => ({ resolveMonochange: vi.fn() }));

import { exec } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockCore = vi.mocked(core);
const mockExec = vi.mocked(exec);
const mockParse = vi.mocked(parseMixedOutput);
const mockResolve = vi.mocked(resolveMonochange);

describe('runReleaseRecord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '{"id":"rel_1"}', stderr: '' });
    mockParse.mockReturnValue({ id: 'rel_1' });
  });

  it('finds release record at HEAD by default', async () => {
    await runReleaseRecord();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'release-record', '--from', 'HEAD', '--format', 'json'],
      { cwd: '.', ignoreReturnCode: true },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('has-release-record', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('json', '{"id":"rel_1"}');
  });

  it('skips when release record is missing by default', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no release record found' });

    await runReleaseRecord();

    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
    expect(mockCore.setOutput).toHaveBeenCalledWith('has-release-record', 'false');
    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('supports dry-run without running command', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'dry-run' ? 'true' : ''));

    await runReleaseRecord();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('reports success without a parsed record when output is not JSON', async () => {
    mockParse.mockReturnValue(undefined);

    await runReleaseRecord();

    expect(mockCore.setOutput).toHaveBeenCalledWith('has-release-record', 'false');
    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('uses fallback missing message when missing output is empty', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'release record missing' });
    mockCore.getInput.mockImplementation((name) => (name === 'ref' ? 'abc123' : ''));

    await runReleaseRecord();

    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'summary',
      'No monochange release record found at abc123.',
    );
  });

  it('uses fallback message for unexpected CLI errors with empty output', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    await expect(runReleaseRecord()).rejects.toThrow(
      'monochange step release-record failed for HEAD',
    );
  });

  it('fails on unexpected CLI errors', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'config parse failed' });

    await expect(runReleaseRecord()).rejects.toThrow('config parse failed');
  });

  it('fails when missing and fail-if-missing is true', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'fail-if-missing' ? 'true' : ''));
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no release record found' });

    await expect(runReleaseRecord()).rejects.toThrow('no release record found');
  });
});
