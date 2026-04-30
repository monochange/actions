import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { runChangesetPolicy } from './';

const githubMock = vi.hoisted(() => ({
  context: {
    actor: 'octocat',
    eventName: 'pull_request',
    payload: {} as Record<string, unknown>,
    repo: { owner: 'mono', repo: 'change' },
    token: 'token',
  },
  getOctokit: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@actions/github', () => githubMock);

vi.mock('../../shared/exec', () => ({
  exec: vi.fn(),
}));

vi.mock('../../shared/json', () => ({
  parseMixedOutput: vi.fn(),
}));

vi.mock('../../shared/monochange-cli', () => ({
  resolveMonochange: vi.fn(),
}));

import { exec } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockExec = vi.mocked(exec);
const mockResolve = vi.mocked(resolveMonochange);
const mockParse = vi.mocked(parseMixedOutput);
const mockCore = vi.mocked(core);

function mockOctokit(comments: { id: number; body?: string | null }[] = []) {
  const octokit = {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
        deleteComment: vi.fn().mockResolvedValue({}),
        listComments: vi.fn().mockResolvedValue({ data: comments }),
        updateComment: vi.fn().mockResolvedValue({}),
      },
    },
  };

  githubMock.getOctokit.mockReturnValue(octokit);

  return octokit;
}

describe('runChangesetPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubMock.context.payload = {};
    githubMock.getOctokit.mockReset();
    mockCore.getInput.mockReturnValue('');
    mockOctokit();
    mockResolve.mockResolvedValue({
      command: 'mc',
      source: 'existing-mc',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '{"packages":[]}' });
    mockParse.mockReturnValue({ packages: [], status: 'passed', summary: 'passed' });
  });

  it('resolves monochange and runs affected check', async () => {
    await runChangesetPolicy();

    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith('mc', ['affected', '--format', 'json', '--verify']);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('logs debug info', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'debug') return 'true';

      return '';
    });

    await runChangesetPolicy();

    expect(mockCore.info).toHaveBeenCalled();
  });

  it('passes optional inputs', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'changed-paths') return 'src/';
      if (name === 'labels') return 'bug,feature';
      if (name === 'skip-labels') return 'skip';

      return '';
    });

    await runChangesetPolicy();

    expect(mockExec).toHaveBeenCalledWith('mc', [
      'affected',
      '--format',
      'json',
      '--verify',
      '--paths',
      'src/',
      '--labels',
      'bug,feature',
      '--skip-labels',
      'skip',
    ]);
  });

  it('outputs dry-run without running command', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'dry-run') return 'true';

      return '';
    });

    await runChangesetPolicy();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
  });

  it('outputs null json when parsed is undefined', async () => {
    mockParse.mockReturnValue(undefined);

    await runChangesetPolicy();

    expect(mockCore.setOutput).toHaveBeenCalledWith('json', 'null');
  });

  it('throws when the affected check exits non-zero', async () => {
    mockExec.mockResolvedValue({
      exitCode: 1,
      stderr: '',
      stdout: '{"status":"failed","summary":"mc affected failed"}',
    });
    mockParse.mockReturnValue({ status: 'failed', summary: 'mc affected failed' });

    await expect(runChangesetPolicy()).rejects.toThrow('mc affected failed');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'failed');
  });

  it('uses stderr as the failure summary when json has no summary', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stderr: 'plain failure', stdout: '' });
    mockParse.mockReturnValue(undefined);

    await expect(runChangesetPolicy()).rejects.toThrow('plain failure');
    expect(mockCore.setOutput).toHaveBeenCalledWith('summary', 'plain failure');
  });

  it('uses a default summary when command output is empty', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
    mockParse.mockReturnValue(undefined);

    await runChangesetPolicy();

    expect(mockCore.setOutput).toHaveBeenCalledWith('summary', 'changeset-policy completed');
  });

  it('falls back when parsed status and summary are not strings', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '{"status":1,"summary":1}' });
    mockParse.mockReturnValue({ status: 1, summary: 1 });

    await runChangesetPolicy();

    expect(mockCore.setOutput).toHaveBeenCalledWith('summary', '{"status":1,"summary":1}');
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('does not comment on failure when pull request context is unavailable', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'comment-on-failure') return 'true';
      if (name === 'github-token') return 'token';

      return '';
    });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '{"status":"failed"}' });
    mockParse.mockReturnValue({ comment: 'failure comment', status: 'failed', summary: 'failed' });
    const octokit = mockOctokit();

    await expect(runChangesetPolicy()).rejects.toThrow('failed');

    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it('warns but still fails when creating the failure comment fails', async () => {
    githubMock.context.payload = { pull_request: { number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'comment-on-failure') return 'true';
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '{"status":"failed"}' });
    mockParse.mockReturnValue({ comment: 'failure comment', status: 'failed', summary: 'failed' });
    const octokit = mockOctokit();
    octokit.rest.issues.createComment.mockRejectedValue(new Error('comment failed'));

    await expect(runChangesetPolicy()).rejects.toThrow('failed');

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Unable to create or update changeset-policy comment: comment failed',
    );
  });

  it('formats non-error comment failures in warnings', async () => {
    githubMock.context.payload = { pull_request: { number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'comment-on-failure') return 'true';
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '{"status":"failed"}' });
    mockParse.mockReturnValue({ comment: 'failure comment', status: 'failed', summary: 'failed' });
    const octokit = mockOctokit();
    octokit.rest.issues.createComment.mockRejectedValue('comment failed');

    await expect(runChangesetPolicy()).rejects.toThrow('failed');

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Unable to create or update changeset-policy comment: comment failed',
    );
  });

  it('skips comment cleanup when pull request context is unavailable', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'token';

      return '';
    });
    const octokit = mockOctokit([{ body: 'old\n<!-- monochange:changeset-policy -->', id: 123 }]);

    await runChangesetPolicy();

    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });

  it('warns and skips comments when repository input is invalid', async () => {
    githubMock.context.payload = { pull_request: { number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'invalid';

      return '';
    });
    const octokit = mockOctokit([{ body: 'old\n<!-- monochange:changeset-policy -->', id: 123 }]);

    await runChangesetPolicy();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Unable to manage changeset-policy comments: invalid repository `invalid`.',
    );
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
  });

  it('marks existing failure comment with checkmark when policy passes', async () => {
    githubMock.context.payload = { pull_request: { head: { ref: 'feature/core' }, number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    mockParse.mockReturnValue({ status: 'passed', summary: 'passed' });
    const octokit = mockOctokit([{ body: 'old\n<!-- monochange:changeset-policy -->', id: 123 }]);

    await runChangesetPolicy();

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      body: '✅ **changeset-policy now passes**\n\n<details>\n<summary>Previous failures</summary>\n\nold\n\n</details>\n\n<!-- monochange:changeset-policy -->',
      comment_id: 123,
      owner: 'mono',
      repo: 'change',
    });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('does not create or update comments when policy passes and there is no existing comment', async () => {
    githubMock.context.payload = { pull_request: { head: { ref: 'feature/core' }, number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    mockParse.mockReturnValue({ status: 'passed', summary: 'passed' });
    const octokit = mockOctokit([]);

    await runChangesetPolicy();

    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('warns but still succeeds when marking comment as passed fails', async () => {
    githubMock.context.payload = { pull_request: { number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    const octokit = mockOctokit([{ body: 'old\n<!-- monochange:changeset-policy -->', id: 123 }]);
    octokit.rest.issues.updateComment.mockRejectedValue(new Error('update failed'));

    await runChangesetPolicy();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Unable to update changeset-policy comment for success: update failed',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('marks existing failure comment with checkmark when monochange reports a skip', async () => {
    githubMock.context.payload = { pull_request: { head: { ref: 'feature/core' }, number: 12 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    mockExec.mockResolvedValue({
      exitCode: 1,
      stderr: '',
      stdout: '{"status":"skipped","summary":"skipped by policy"}',
    });
    mockParse.mockReturnValue({ status: 'skipped', summary: 'skipped by policy' });
    const octokit = mockOctokit([{ body: 'old\n<!-- monochange:changeset-policy -->', id: 123 }]);

    await runChangesetPolicy();

    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith('mc', ['affected', '--format', 'json', '--verify']);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'skipped');
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      body: '✅ **changeset-policy now passes**\n\n<details>\n<summary>Previous failures</summary>\n\nold\n\n</details>\n\n<!-- monochange:changeset-policy -->',
      comment_id: 123,
      owner: 'mono',
      repo: 'change',
    });
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });

  it('posts the monochange comment when policy fails', async () => {
    githubMock.context.payload = { pull_request: { head: { ref: 'feature/core' }, number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'comment-on-failure') return 'true';
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    mockExec.mockResolvedValue({
      exitCode: 1,
      stderr: '',
      stdout: '{"status":"failed"}',
    });
    mockParse.mockReturnValue({
      comment: '### monochange changeset verification failed\n\nAdd a changeset.',
      status: 'failed',
      summary: 'changeset verification failed',
    });
    const octokit = mockOctokit();

    await expect(runChangesetPolicy()).rejects.toThrow('changeset verification failed');

    expect(mockCore.info).toHaveBeenCalledWith(
      '### monochange changeset verification failed\n\nAdd a changeset.',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'comment',
      '### monochange changeset verification failed\n\nAdd a changeset.',
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      body: '### monochange changeset verification failed\n\nAdd a changeset.\n\n<!-- monochange:changeset-policy -->',
      issue_number: 42,
      owner: 'mono',
      repo: 'change',
    });
  });

  it('updates an existing failure comment with previous failures collapsed', async () => {
    githubMock.context.payload = { pull_request: { head: { ref: 'feature/core' }, number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'comment-on-failure') return 'true';
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '{"status":"failed"}' });
    mockParse.mockReturnValue({ comment: 'new comment', status: 'failed', summary: 'failed' });
    const octokit = mockOctokit([
      { body: 'old\n<!-- monochange:changeset-policy -->', id: 1 },
      { body: 'stale\n<!-- monochange:changeset-policy -->', id: 2 },
    ]);

    await expect(runChangesetPolicy()).rejects.toThrow('failed');

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      body: 'new comment\n\n<details>\n<summary>Previous failures</summary>\n\nold\n\n</details>\n\n<!-- monochange:changeset-policy -->',
      comment_id: 1,
      owner: 'mono',
      repo: 'change',
    });
    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledWith({
      comment_id: 2,
      owner: 'mono',
      repo: 'change',
    });
  });

  it('does not update the comment when the same failure occurs again', async () => {
    githubMock.context.payload = { pull_request: { head: { ref: 'feature/core' }, number: 42 } };
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'comment-on-failure') return 'true';
      if (name === 'github-token') return 'token';
      if (name === 'repository') return 'mono/change';

      return '';
    });
    mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '{"status":"failed"}' });
    mockParse.mockReturnValue({ comment: 'failure comment', status: 'failed', summary: 'failed' });
    const octokit = mockOctokit([
      { body: 'failure comment\n<!-- monochange:changeset-policy -->', id: 1 },
    ]);

    await expect(runChangesetPolicy()).rejects.toThrow('failed');

    expect(mockCore.info).toHaveBeenCalledWith('Failure comment unchanged, skipping update');
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
