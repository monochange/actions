import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { exec, execRequired } from './exec';
import { resolveMonochange, runMcCommand, runMcJsonCommand } from './monochange-cli';
import { installMonochange } from './monochange-install';
import { monochangeRelease } from './monochange-release';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
}));

vi.mock('./exec', () => ({
  exec: vi.fn(),
  execRequired: vi.fn(),
}));

vi.mock('./monochange-install', () => ({ installMonochange: vi.fn() }));

const mockExec = vi.mocked(exec);
const mockExecRequired = vi.mocked(execRequired);
const mockCoreInfo = vi.mocked(core.info);
const mockInstall = vi.mocked(installMonochange);

describe('resolveMonochange', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockInstall.mockResolvedValue('/tmp/action tools/monochange');
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

  it('executes the verified absolute binary when monochange is not found', async () => {
    mockExec.mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' }).mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
      stdout: `monochange ${monochangeRelease.version}`,
    });

    const result = await resolveMonochange('true');

    expect(result).toEqual({
      command: '"/tmp/action tools/monochange"',
      source: 'pinned-download',
      version: `monochange ${monochangeRelease.version}`,
    });
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(mockExec).toHaveBeenLastCalledWith(result.command, ['--version'], {
      ignoreReturnCode: true,
      silent: true,
    });

    await runMcCommand({ command: result.command, args: ['check'], cwd: '/consumer' });

    expect(mockExecRequired).toHaveBeenCalledWith(result.command, ['check'], { cwd: '/consumer' });
  });

  it('never executes package managers during automatic setup', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });
    mockInstall.mockRejectedValue(new Error('installation failed'));
    mockExecRequired.mockRejectedValue(new Error('installation failed'));

    await expect(resolveMonochange('true')).rejects.toThrow();

    expect(mockExec.mock.calls.map(([command]) => command)).not.toContain('npx');
    expect(mockExecRequired.mock.calls.map(([command]) => command)).not.toContain('cargo');
  });

  it('rejects a downloaded binary reporting a different version', async () => {
    mockExec
      .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' })
      .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: 'monochange 99.0.0' });

    await expect(resolveMonochange('true')).rejects.toThrow('did not report the expected version');
  });

  it('fails closed when downloading the pinned artifact fails', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });
    mockInstall.mockRejectedValue(new Error('Integrity check failed'));

    await expect(resolveMonochange('true')).rejects.toThrow('Integrity check failed');
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
