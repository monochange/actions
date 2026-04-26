import { describe, expect, it, vi } from 'vitest';

import * as actionsExec from '@actions/exec';

import { exec, execRequired } from './exec';

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
}));

describe('exec', () => {
  it('captures stdout and stderr', async () => {
    vi.mocked(actionsExec.exec).mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('hello'));
      opts?.listeners?.stderr?.(Buffer.from('world'));

      return 0;
    });

    const result = await exec('git', ['status']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('world');
  });

  it('returns non-zero exit code without throwing', async () => {
    vi.mocked(actionsExec.exec).mockResolvedValue(1);

    const result = await exec('git', ['fail']);

    expect(result.exitCode).toBe(1);
  });
});

describe('execRequired', () => {
  it('returns trimmed stdout on success', async () => {
    vi.mocked(actionsExec.exec).mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('  success  '));

      return 0;
    });

    const result = await execRequired('git', ['status']);

    expect(result).toBe('success');
  });

  it('throws on failure', async () => {
    vi.mocked(actionsExec.exec).mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stderr?.(Buffer.from('error message'));

      return 1;
    });

    await expect(execRequired('git', ['fail'])).rejects.toThrow('error message');
  });

  it('throws generic error when no stderr or stdout', async () => {
    vi.mocked(actionsExec.exec).mockResolvedValue(1);

    await expect(execRequired('git', ['fail'])).rejects.toThrow('git failed');
  });

  it('respects cwd option', async () => {
    const mockExecImpl = vi.fn().mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('ok'));
      return 0;
    });
    vi.mocked(actionsExec.exec).mockImplementation(mockExecImpl);

    await exec('git', ['status'], { cwd: '/tmp' });

    expect(mockExecImpl).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('respects env option', async () => {
    const mockExecImpl = vi.fn().mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('ok'));
      return 0;
    });
    vi.mocked(actionsExec.exec).mockImplementation(mockExecImpl);

    await exec('git', ['status'], { env: { FOO: 'bar' } });

    expect(mockExecImpl).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ env: { FOO: 'bar' } }),
    );
  });
});
