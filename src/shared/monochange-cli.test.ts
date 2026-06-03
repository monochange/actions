import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { exec, execRequired } from './exec';
import { resolveMonochange, runMcCommand, runMcJsonCommand } from './monochange-cli';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
}));

vi.mock('./exec', () => ({
  exec: vi.fn(),
  execRequired: vi.fn(),
}));

const mockExec = vi.mocked(exec);
const mockExecRequired = vi.mocked(execRequired);
const mockCoreInfo = vi.mocked(core.info);

describe('resolveMonochange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing monochange when found and setupInput is true', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '  monochange 1.2.3  ' });

    const result = await resolveMonochange('true');

    expect(result).toEqual({
      command: 'monochange',
      source: 'existing-monochange',
      version: 'monochange 1.2.3',
    });
    expect(mockExec).toHaveBeenCalledWith('monochange', ['--version'], {
      ignoreReturnCode: true,
      silent: true,
    });
  });

  it('falls back to npx when monochange not found', async () => {
    mockExec
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' })
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '  monochange 2.0.0  ' });

    const result = await resolveMonochange('true');

    expect(result).toEqual({
      command: 'npx -y @monochange/cli',
      source: 'npx-shim',
      version: 'monochange 2.0.0',
    });
  });

  it('falls back to cargo binstall when npx fails', async () => {
    mockExec
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' })
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' });
    mockExecRequired.mockResolvedValue('');
    mockExec.mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: 'monochange 3.0.0' });

    const result = await resolveMonochange('true');

    expect(result).toEqual({
      command: 'monochange',
      source: 'cargo-binstall',
      version: 'monochange 3.0.0',
    });
  });

  it('throws when cargo binstall succeeds but monochange is still not found', async () => {
    mockExec
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' })
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' });
    mockExecRequired.mockResolvedValue('');
    mockExec.mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' });

    await expect(resolveMonochange('true')).rejects.toThrow(
      'Could not resolve monochange automatically',
    );
  });

  it('throws when cargo binstall itself fails', async () => {
    mockExec
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' })
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' });
    mockExecRequired.mockRejectedValue(new Error('cargo not found'));

    await expect(resolveMonochange('true')).rejects.toThrow(
      'Could not resolve monochange automatically',
    );
  });

  it('throws when monochange returns exitCode 0 but empty stdout', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });

    await expect(resolveMonochange('false')).rejects.toThrow('monochange is not available on PATH');
  });

  it('throws when custom command returns exitCode 0 but empty stdout', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });

    await expect(resolveMonochange('/opt/bin/monochange')).rejects.toThrow(
      'did not produce a valid monochange --version output',
    );
  });

  it('returns existing monochange when setupInput is false', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'monochange 1.0.0' });

    const result = await resolveMonochange('false');

    expect(result).toEqual({
      command: 'monochange',
      source: 'existing-monochange',
      version: 'monochange 1.0.0',
    });
    expect(mockExec).toHaveBeenCalledWith('monochange', ['--version'], {
      ignoreReturnCode: true,
      silent: true,
    });
  });

  it('throws when setupInput is false and monochange is missing', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });

    await expect(resolveMonochange('false')).rejects.toThrow(
      'monochange is not available on PATH and setup-monochange is false',
    );
  });

  it('uses custom command when provided', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'monochange 4.0.0' });

    const result = await resolveMonochange('/opt/bin/monochange');

    expect(result).toEqual({
      command: '/opt/bin/monochange',
      source: 'custom-command',
      version: 'monochange 4.0.0',
    });
    expect(mockExec).toHaveBeenCalledWith('/opt/bin/monochange', ['--version'], {
      ignoreReturnCode: true,
      silent: true,
    });
  });

  it('throws when custom command fails', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });

    await expect(resolveMonochange('/bad/path')).rejects.toThrow(
      'did not produce a valid monochange --version output',
    );
  });
});

describe('runMcCommand', () => {
  it('runs the command and logs it', async () => {
    mockExecRequired.mockResolvedValue('output');

    const result = await runMcCommand({ args: ['status'], command: 'monochange' });

    expect(result).toBe('output');
    expect(mockCoreInfo).toHaveBeenCalledWith('Running: monochange status');
  });

  it('passes cwd when provided', async () => {
    mockExecRequired.mockResolvedValue('output');

    await runMcCommand({ args: ['status'], command: 'monochange', cwd: '/tmp' });

    expect(mockExecRequired).toHaveBeenCalledWith('monochange', ['status'], { cwd: '/tmp' });
  });
});

describe('runMcJsonCommand', () => {
  it('parses JSON output', async () => {
    mockExecRequired.mockResolvedValue('{"a":1}');

    const result = await runMcJsonCommand({ args: ['status'], command: 'monochange' });

    expect(result).toEqual({ a: 1 });
  });
});
