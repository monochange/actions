import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { runFailWhen } from './index';

vi.mock('@actions/core');
vi.mock('@actions/github');

const mockCore = vi.mocked(core);
const mockGithub = vi.mocked(github);

const DEFAULT_REASON = 'fail-when condition evaluated to true.';

let summaryAddRaw: ReturnType<typeof vi.fn>;

function setInputs(values: Record<string, string>): void {
  mockCore.getInput.mockImplementation((name: string) => values[name] ?? '');
}

function setOctokit(options?: {
  createComment?: ReturnType<typeof vi.fn>;
  pullGet?: ReturnType<typeof vi.fn>;
}): {
  createComment: ReturnType<typeof vi.fn>;
  pullGet: ReturnType<typeof vi.fn>;
} {
  const createComment = options?.createComment ?? vi.fn().mockResolvedValue({});
  const pullGet = options?.pullGet ?? vi.fn().mockResolvedValue({ data: { number: 7 } });

  mockGithub.getOctokit.mockReturnValue({
    rest: {
      issues: { createComment },
      pulls: { get: pullGet },
    },
  } as unknown as ReturnType<typeof github.getOctokit>);

  return { createComment, pullGet };
}

describe('runFailWhen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setInputs({});
    summaryAddRaw = vi.fn().mockReturnValue({ write: vi.fn().mockResolvedValue(undefined) });
    mockCore.summary = {
      addRaw: summaryAddRaw,
    } as unknown as typeof core.summary;
    mockGithub.context = {
      eventName: 'pull_request',
      repo: { owner: 'monochange', repo: 'actions' },
      actor: 'test-actor',
      runId: 42,
      payload: {},
    } as typeof github.context;
    setOctokit();
  });

  it('skips without requiring any other inputs when should-fail is false', async () => {
    await runFailWhen();

    expect(mockCore.notice).toHaveBeenCalledWith('should-fail evaluated to false. Skipping.');
    expect(mockCore.setOutput).toHaveBeenCalledWith('failed', 'false');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
    expect(mockGithub.getOctokit).not.toHaveBeenCalled();
    expect(summaryAddRaw).not.toHaveBeenCalled();
  });

  it('fails with the default reason when no reason input is provided', async () => {
    setInputs({ 'should-fail': 'true' });

    await expect(runFailWhen()).rejects.toThrow(DEFAULT_REASON);

    expect(mockCore.setOutput).toHaveBeenCalledWith('failed', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith('reason', DEFAULT_REASON);
    expect(summaryAddRaw).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_REASON));
    expect(mockGithub.getOctokit).not.toHaveBeenCalled();
  });

  it('fails with a custom reason without trying to comment when no fail-comment is provided', async () => {
    setInputs({ reason: 'Blocked manually', 'should-fail': 'true' });

    await expect(runFailWhen()).rejects.toThrow('Blocked manually');

    expect(mockCore.setOutput).toHaveBeenCalledWith('reason', 'Blocked manually');
    expect(mockGithub.getOctokit).not.toHaveBeenCalled();
  });

  it('posts a comment to the current pull_request event when fail-comment is provided', async () => {
    setInputs({
      'fail-comment': 'Please use /merge',
      'github-token': 'token',
      reason: 'test reason',
      repository: 'monochange/actions',
      'should-fail': 'true',
    });
    mockGithub.context.payload = { pull_request: { number: 5 } };
    const { createComment } = setOctokit();

    await expect(runFailWhen()).rejects.toThrow('test reason');

    expect(createComment).toHaveBeenCalledWith({
      body: expect.stringContaining('Please use /merge'),
      issue_number: 5,
      owner: 'monochange',
      repo: 'actions',
    });
    expect(mockCore.setOutput).toHaveBeenCalledWith('pull-request-number', '5');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'comment',
      expect.stringContaining('Please use /merge'),
    );
    expect(summaryAddRaw).toHaveBeenCalledWith(
      expect.stringContaining('Triggered by @test-actor.'),
    );
  });

  it('resolves the pull request from an issue_comment event', async () => {
    setInputs({
      'fail-comment': 'comment body',
      'github-token': 'token',
      reason: 'reason',
      repository: 'o/r',
      'should-fail': 'true',
    });
    mockGithub.context.payload = { issue: { number: 88, pull_request: {} } };
    const { createComment, pullGet } = setOctokit({
      pullGet: vi.fn().mockResolvedValue({ data: { number: 88 } }),
    });

    await expect(runFailWhen()).rejects.toThrow('reason');

    expect(pullGet).toHaveBeenCalledWith({ owner: 'o', pull_number: 88, repo: 'r' });
    expect(createComment).toHaveBeenCalledWith({
      body: expect.stringContaining('comment body'),
      issue_number: 88,
      owner: 'o',
      repo: 'r',
    });
  });

  it('resolves the pull request from explicit pull-request input', async () => {
    setInputs({
      'fail-comment': 'comment body',
      'github-token': 'token',
      'pull-request': '42',
      reason: 'reason',
      repository: 'o/r',
      'should-fail': 'true',
    });
    const { pullGet } = setOctokit({
      pullGet: vi.fn().mockResolvedValue({ data: { number: 42 } }),
    });

    await expect(runFailWhen()).rejects.toThrow('reason');

    expect(pullGet).toHaveBeenCalledWith({ owner: 'o', pull_number: 42, repo: 'r' });
  });

  it('warns without posting when no pull request can be resolved', async () => {
    setInputs({
      'fail-comment': 'no pr found',
      'github-token': 'token',
      reason: 'reason',
      repository: 'o/r',
      'should-fail': 'true',
    });
    const { createComment } = setOctokit();

    await expect(runFailWhen()).rejects.toThrow('reason');

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('no pull request could be resolved'),
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it('warns when comment posting fails with an Error', async () => {
    setInputs({
      'fail-comment': 'xyz',
      'github-token': 'token',
      reason: 'test reason',
      repository: 'monochange/actions',
      'should-fail': 'true',
    });
    mockGithub.context.payload = { pull_request: { number: 5 } };
    setOctokit({ createComment: vi.fn().mockRejectedValue(new Error('network')) });

    await expect(runFailWhen()).rejects.toThrow('test reason');

    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('network'));
  });

  it('warns when comment posting fails with a non-Error', async () => {
    setInputs({
      'fail-comment': 'fail comment',
      'github-token': 'token',
      reason: 'test reason',
      repository: 'monochange/actions',
      'should-fail': 'true',
    });
    mockGithub.context.payload = { pull_request: { number: 5 } };
    setOctokit({ createComment: vi.fn().mockRejectedValue('network') });

    await expect(runFailWhen()).rejects.toThrow('test reason');

    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('network'));
  });

  it('warns when writing the action summary fails', async () => {
    setInputs({ reason: 'summary reason', 'should-fail': 'true' });
    summaryAddRaw = vi.fn().mockReturnValue({
      write: vi.fn().mockRejectedValue(new Error('summary unavailable')),
    });
    mockCore.summary = {
      addRaw: summaryAddRaw,
    } as unknown as typeof core.summary;

    await expect(runFailWhen()).rejects.toThrow('summary reason');

    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('summary unavailable'));
  });

  it('throws for invalid pull-request input', async () => {
    setInputs({
      'fail-comment': 'comment',
      'github-token': 'token',
      'pull-request': 'abc',
      reason: 'r',
      repository: 'o/r',
      'should-fail': 'true',
    });

    await expect(runFailWhen()).rejects.toThrow(/must be a positive integer/);
  });

  it('throws for zero pull-request input', async () => {
    setInputs({
      'fail-comment': 'comment',
      'github-token': 'token',
      'pull-request': '0',
      reason: 'r',
      repository: 'o/r',
      'should-fail': 'true',
    });

    await expect(runFailWhen()).rejects.toThrow(/must be a positive integer/);
  });

  it('throws for invalid repository format', async () => {
    setInputs({
      'fail-comment': 'comment',
      'github-token': 'token',
      reason: 'r',
      repository: 'badformat',
      'should-fail': 'true',
    });

    await expect(runFailWhen()).rejects.toThrow(/must be in owner\/repo format/);
  });
});
