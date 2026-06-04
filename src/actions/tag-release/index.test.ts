import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runTagRelease } from './index';

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

describe('runTagRelease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"tags":{"pkg-a":"pkg-a@1.0.0"}}');
    mockParse.mockReturnValue({ tags: { 'pkg-a': 'pkg-a@1.0.0' } });
  });

  it('runs tag-release from HEAD by default', async () => {
    await runTagRelease();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'tag-release', '--from', 'HEAD', '--format', 'json'],
      { cwd: '.' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('tags', '{"pkg-a":"pkg-a@1.0.0"}');
  });

  it('selects a tag by id', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'id' ? 'pkg-a' : ''));

    await runTagRelease();

    expect(mockCore.setOutput).toHaveBeenCalledWith('tag', 'pkg-a@1.0.0');
  });

  it('selects a tag by package input', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'package' ? 'pkg-a' : ''));

    await runTagRelease();

    expect(mockCore.setOutput).toHaveBeenCalledWith('tag', 'pkg-a@1.0.0');
  });

  it('outputs empty tags when parsed output is not an object', async () => {
    mockParse.mockReturnValue(undefined);
    mockCore.getInput.mockImplementation((name) => (name === 'id' ? 'pkg-a' : ''));

    await runTagRelease();

    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
    expect(mockCore.setOutput).toHaveBeenCalledWith('tags', '{}');
    expect(mockCore.setOutput).toHaveBeenCalledWith('tag', '');
  });

  it('outputs empty selected tag for non-scalar tag values', async () => {
    mockParse.mockReturnValue({ tags: { 'pkg-a': { tag: 'pkg-a@1.0.0' } } });
    mockCore.getInput.mockImplementation((name) => (name === 'id' ? 'pkg-a' : ''));

    await runTagRelease();

    expect(mockCore.setOutput).toHaveBeenCalledWith('tag', '');
  });

  it('supports dry-run without running command', async () => {
    mockCore.getInput.mockImplementation((name) => (name === 'dry-run' ? 'true' : ''));

    await runTagRelease();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
  });
});
