import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { runFailWhen } from './index';

vi.mock('@actions/core');
vi.mock('@actions/github');

const mockCore = vi.mocked(core);
const mockGithub = vi.mocked(github);

describe('runFailWhen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.getInput.mockReturnValue('');
    mockCore.getBooleanInput.mockReturnValue(false);
    mockCore.summary = {
      addRaw: vi.fn().mockReturnValue({ write: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as typeof core.summary;
    mockGithub.context = {
      eventName: 'pull_request',
      repo: { owner: 'monochange', repo: 'actions' },
      actor: 'test-actor',
      runId: 42,
      payload: {},
    } as typeof github.context;
    mockGithub.getOctokit.mockReturnValue({
      rest: {
        issues: { createComment: vi.fn().mockResolvedValue({}) },
        pulls: { get: vi.fn().mockResolvedValue({ data: { number: 7 } }) },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);
  });

  it('skips when should-fail is false', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'repository') return 'monochange/actions';
      return '';
    });

    await runFailWhen();
    expect(mockCore.setOutput).toHaveBeenCalledWith('failed', 'false');
    expect(mockCore.notice).toHaveBeenCalledWith('should-fail evaluated to false. Skipping.');
  });

  it('throws with outputs when should-fail is true', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'Blocked manually';
      if (name === 'repository') return 'monochange/actions';
      return '';
    });

    await expect(runFailWhen()).rejects.toThrow('Blocked manually');
    expect(mockCore.setOutput).toHaveBeenCalledWith('failed', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('reason', 'Blocked manually');
  });

  it('posts comment on PR when comment is provided', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'test reason';
      if (name === 'repository') return 'monochange/actions';
      if (name === 'fail-comment') return 'Please use /merge';
      return '';
    });
    mockGithub.context.payload = {
      pull_request: { number: 5 },
    };

    const mockCreateComment = vi.fn().mockResolvedValue({});
    mockGithub.getOctokit.mockReturnValue({
      rest: {
        issues: { createComment: mockCreateComment },
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 5 } }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);

    await expect(runFailWhen()).rejects.toThrow('test reason');
    expect(mockCreateComment).toHaveBeenCalledWith({
      body: expect.stringContaining('Please use /merge'),
      issue_number: 5,
      owner: 'monochange',
      repo: 'actions',
    });
  });

  it('warns when comment posting fails', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'test reason';
      if (name === 'repository') return 'monochange/actions';
      if (name === 'fail-comment') return 'xyz';
      return '';
    });
    mockGithub.context.payload = {
      pull_request: { number: 5 },
    };
    mockGithub.getOctokit.mockReturnValue({
      rest: {
        issues: {
          createComment: vi.fn().mockRejectedValue(new Error('network')),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 5 } }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);

    await expect(runFailWhen()).rejects.toThrow('test reason');
    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('network'));
  });

  it('handles comment failure with a non-Error gracefully', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'test reason';
      if (name === 'fail-comment') return 'fail comment';
      if (name === 'repository') return 'monochange/actions';
      if (name === 'github-token') return 'token';
      return '';
    });
    mockGithub.context.payload = {
      pull_request: { number: 5 },
    };
    mockGithub.getOctokit.mockReturnValue({
      rest: {
        issues: {
          createComment: vi.fn().mockRejectedValue('network'),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 5 } }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);

    await expect(runFailWhen()).rejects.toThrow('test reason');
    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('network'));
  });

  it('resolves PR from event payload', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'reason';
      if (name === 'repository') return 'o/r';
      return '';
    });
    mockGithub.context.payload = {
      pull_request: { number: 99 },
    };

    await expect(runFailWhen()).rejects.toThrow('reason');
  });

  it('resolves PR from issue comment payload', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'reason';
      if (name === 'repository') return 'o/r';
      return '';
    });
    mockGithub.context.payload = {
      issue: { number: 88, pull_request: {} },
    };

    await expect(runFailWhen()).rejects.toThrow('reason');
  });

  it('resolves PR from explicit pull-request input', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'reason';
      if (name === 'repository') return 'o/r';
      if (name === 'pull-request') return '42';
      return '';
    });

    const mockGet = vi.fn().mockResolvedValue({ data: { number: 42 } });
    mockGithub.getOctokit.mockReturnValue({
      rest: {
        issues: { createComment: vi.fn().mockResolvedValue({}) },
        pulls: { get: mockGet },
      },
    } as unknown as ReturnType<typeof github.getOctokit>);

    await expect(runFailWhen()).rejects.toThrow('reason');
    expect(mockGet).toHaveBeenCalledWith({ owner: 'o', pull_number: 42, repo: 'r' });
  });

  it('handles no PR found in any context', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'reason';
      if (name === 'repository') return 'o/r';
      if (name === 'fail-comment') return 'no pr found';
      return '';
    });
    mockGithub.context.payload = {};

    await expect(runFailWhen()).rejects.toThrow('reason');
  });

  it('throws for invalid pull-request input', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'r';
      if (name === 'repository') return 'o/r';
      if (name === 'pull-request') return 'abc';
      return '';
    });

    await expect(runFailWhen()).rejects.toThrow(/must be a positive integer/);
  });

  it('throws for zero pull-request input', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'r';
      if (name === 'repository') return 'o/r';
      if (name === 'pull-request') return '0';
      return '';
    });

    await expect(runFailWhen()).rejects.toThrow(/must be a positive integer/);
  });

  it('throws for negative pull-request input', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'r';
      if (name === 'repository') return 'o/r';
      if (name === 'pull-request') return '-1';
      return '';
    });

    await expect(runFailWhen()).rejects.toThrow(/must be a positive integer/);
  });

  it('throws for invalid repository format', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'r';
      if (name === 'repository') return 'badformat';
      return '';
    });

    await expect(runFailWhen()).rejects.toThrow(/must be in owner\/repo format/);
  });

  it('allows skipping comment when no comment input', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'should-fail') return 'true';
      if (name === 'reason') return 'r';
      if (name === 'repository') return 'o/r';
      return '';
    });

    await expect(runFailWhen()).rejects.toThrow('r');
  });
});
