import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { runReleasePr } from './index';

vi.mock('@actions/core');

vi.mock('@actions/github', () => ({
  context: {
    actor: 'octocat',
    eventName: 'push',
    payload: {},
    repo: { owner: 'monochange', repo: 'actions' },
  },
  getOctokit: vi.fn(),
}));

vi.mock('../../shared/exec', () => ({
  execRequired: vi.fn(),
}));

vi.mock('../../shared/json', () => ({
  parseMixedOutput: vi.fn(),
}));

vi.mock('../../shared/monochange-cli', () => ({
  resolveMonochange: vi.fn(),
}));

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockExec = vi.mocked(execRequired);
const mockResolve = vi.mocked(resolveMonochange);
const mockParse = vi.mocked(parseMixedOutput);
const mockCore = vi.mocked(core);
const mockGithub = vi.mocked(github);

function setCommentContext(options: {
  actor?: string;
  body?: unknown;
  isPullRequest?: boolean;
}): void {
  Object.assign(mockGithub.context, {
    actor: options.actor ?? 'octocat',
    eventName: 'issue_comment',
    payload: {
      comment: options.body === undefined ? undefined : { body: options.body },
      issue: options.isPullRequest === false ? {} : { pull_request: {} },
    },
    repo: { owner: 'monochange', repo: 'actions' },
  });
}

function mockCollaboratorPermission(data: { permission: string; role_name?: string }): void {
  const getCollaboratorPermissionLevel = vi.fn().mockResolvedValue({ data });

  mockGithub.getOctokit.mockReturnValue({
    rest: {
      repos: {
        getCollaboratorPermissionLevel,
      },
    },
  } as unknown as ReturnType<typeof github.getOctokit>);
}

describe('runReleasePr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockGithub.context, {
      actor: 'octocat',
      eventName: 'push',
      payload: {},
      repo: { owner: 'monochange', repo: 'actions' },
    });
    mockCore.getInput.mockReturnValue('');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"number":42}');
    mockParse.mockReturnValue({
      baseBranch: 'main',
      headBranch: 'release/1.0',
      number: 42,
      url: 'https://github.com/monochange/actions/pull/42',
    });
  });

  it('runs release-pr and sets outputs', async () => {
    await runReleasePr();
    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-release-request', '--format', 'json'],
      {
        cwd: '.',
      },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '42');
  });

  it('logs debug info', async () => {
    mockCore.getInput.mockImplementation((name: string) => {
      if (name === 'debug') return 'true';
      return '';
    });

    await runReleasePr();

    expect(mockCore.info).toHaveBeenCalled();
  });

  it('outputs empty release-request-number when parsed number is not a number or string', async () => {
    mockParse.mockReturnValue({ number: null });

    await runReleasePr();

    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '');
  });

  it('outputs release-request-number when parsed number is a string', async () => {
    mockParse.mockReturnValue({ number: '42' });

    await runReleasePr();

    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '42');
  });

  it('masks the token and passes it only to the CLI', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'secret-token';
      return '';
    });

    await runReleasePr();

    expect(mockCore.setSecret).toHaveBeenCalledWith('secret-token');
    expect(mockCore.exportVariable).not.toHaveBeenCalled();
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-release-request', '--format', 'json'],
      { cwd: '.', env: expect.objectContaining({ GITHUB_TOKEN: 'secret-token' }) },
    );
  });

  it('outputs dry-run values without running command', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'dry-run') return 'true';
      if (name === 'github-token') return 'secret-token';
      return '';
    });

    await runReleasePr();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCore.setSecret).not.toHaveBeenCalled();
    expect(mockCore.exportVariable).not.toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'dry-run');
  });

  it('outputs empty values when parsed is undefined', async () => {
    mockParse.mockReturnValue(undefined);

    await runReleasePr();

    expect(mockCore.setOutput).toHaveBeenCalledWith('release-request-number', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('head-branch', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('base-branch', '');
  });

  it('throws when execRequired fails', async () => {
    mockExec.mockRejectedValue(new Error('monochange step open-release-request failed'));

    await expect(runReleasePr()).rejects.toThrow('monochange step open-release-request failed');
  });

  it('forwards refresh, banner-only, and from flags', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'refresh') return 'true';
      if (name === 'banner-only') return 'true';
      if (name === 'from') return 'origin/main';
      return '';
    });

    await runReleasePr();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'step',
        'open-release-request',
        '--format',
        'json',
        '--refresh',
        '--banner-only',
        '--from',
        'origin/main',
      ],
      { cwd: '.' },
    );
  });

  it('accepts minimum-reviewer-permission=write for /refresh comments', async () => {
    setCommentContext({ body: '/refresh' });
    mockCollaboratorPermission({ permission: 'write', role_name: 'write' });
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'secret-token';
      if (name === 'minimum-reviewer-permission') return 'write';
      return '';
    });

    await runReleasePr();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-release-request', '--format', 'json', '--refresh'],
      expect.objectContaining({ cwd: '.' }),
    );
  });

  it('uses role_name so maintain permission authorizes maintainers and rejects write-only users', async () => {
    setCommentContext({ body: 'please /refresh' });
    mockCollaboratorPermission({ permission: 'write', role_name: 'maintain' });
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'secret-token';
      return '';
    });

    await runReleasePr();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-release-request', '--format', 'json', '--refresh'],
      expect.any(Object),
    );

    vi.clearAllMocks();
    setCommentContext({ body: '/refresh' });
    mockCollaboratorPermission({ permission: 'write', role_name: 'write' });
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'secret-token';
      return '';
    });

    await expect(runReleasePr()).rejects.toThrow(
      'Actor `octocat` has `write` permission, which does not meet required `maintain` permission for `/refresh`.',
    );
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('falls back to data.permission when role_name is absent and supports push/admin', async () => {
    setCommentContext({ body: '/recut' });
    mockCollaboratorPermission({ permission: 'write' });
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'secret-token';
      if (name === 'minimum-reviewer-permission') return 'push';
      if (name === 'refresh-command') return '/recut';
      return '';
    });

    await runReleasePr();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      ['step', 'open-release-request', '--format', 'json', '--refresh'],
      expect.any(Object),
    );

    vi.clearAllMocks();
    setCommentContext({ body: '/refresh' });
    mockCollaboratorPermission({ permission: 'write', role_name: 'maintain' });
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'github-token') return 'secret-token';
      if (name === 'minimum-reviewer-permission') return 'admin';
      return '';
    });

    await expect(runReleasePr()).rejects.toThrow('does not meet required `admin` permission');
  });

  it('rejects invalid minimum-reviewer-permission values instead of silently defaulting', async () => {
    mockCore.getInput.mockImplementation((name) => {
      if (name === 'minimum-reviewer-permission') return 'read';
      return '';
    });

    await expect(runReleasePr()).rejects.toThrow(
      'Input `minimum-reviewer-permission` must be one of admin, maintain, write, or push. Received `read`.',
    );
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('validates issue_comment PR presence, command body, and github-token', async () => {
    setCommentContext({ body: '/refresh', isPullRequest: false });
    await expect(runReleasePr()).rejects.toThrow('the issue is not a pull request');

    setCommentContext({ body: undefined });
    await expect(runReleasePr()).rejects.toThrow('comment does not contain `/refresh`');

    setCommentContext({ body: 'looks good' });
    await expect(runReleasePr()).rejects.toThrow('comment does not contain `/refresh`');

    setCommentContext({ body: '/refresh' });
    await expect(runReleasePr()).rejects.toThrow('Input `github-token` is required');
  });
});
