import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';
import * as github from '@actions/github';

import {
  assertHostedReleaseSupport,
  explainHostedFailure,
  parseReleaseRequestTarget,
  runHostedRelease,
} from './index';

vi.mock('@actions/core');
vi.mock('@actions/github', () => ({ getOctokit: vi.fn() }));
vi.mock('../../shared/exec', () => ({ execRequired: vi.fn() }));
vi.mock('../../shared/monochange-cli', () => ({ resolveMonochange: vi.fn() }));

import { execRequired } from '../../shared/exec';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockCore = vi.mocked(core);
const mockGithub = vi.mocked(github);
const mockExec = vi.mocked(execRequired);
const mockResolve = vi.mocked(resolveMonochange);

const RELEASE_REQUEST_JSON = JSON.stringify({
  release_request: {
    base_branch: 'main',
    head_branch: 'monochange/release/step-open-release-request',
    owner: 'acme',
    repo: 'widgets',
  },
});

function setInputs(inputs: Record<string, string>): void {
  mockCore.getInput.mockImplementation((name: string) => inputs[name] ?? '');
}

function setOctokit(options?: {
  verified?: boolean;
  pulls?: { number: number; html_url: string }[];
}) {
  const getRef = vi.fn().mockResolvedValue({ data: { object: { sha: 'release-sha' } } });
  const getCommit = vi.fn().mockResolvedValue({
    data: { verification: { reason: 'valid', verified: options?.verified ?? true } },
  });
  const list = vi.fn().mockResolvedValue({
    data: options?.pulls ?? [{ html_url: 'https://github.com/acme/widgets/pull/42', number: 42 }],
  });

  mockGithub.getOctokit.mockReturnValue({
    rest: { git: { getCommit, getRef }, pulls: { list } },
  } as unknown as ReturnType<typeof github.getOctokit>);

  return { getCommit, getRef, list };
}

function outputs(): Record<string, unknown> {
  return Object.fromEntries(mockCore.setOutput.mock.calls);
}

describe('runHostedRelease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://token.actions.example/request');
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-token');
    vi.stubEnv('GITHUB_HEAD_REF', '');
    setInputs({ 'github-token': 'gh-token' });
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: 'monochange 0.18.0',
    });
    mockExec.mockImplementation(async (_command, args) =>
      args.includes('open-release-request') ? RELEASE_REQUEST_JSON : '{}',
    );
    setOctokit();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prepares, commits, and opens the release through the hosted app', async () => {
    const { getCommit, getRef, list } = setOctokit();

    await runHostedRelease();

    const calls = mockExec.mock.calls.map(([command, args]) => [command, ...args].join(' '));
    expect(calls).toEqual([
      'monochange step prepare-release --format json',
      'monochange step open-release-request --backend hosted --dry-run --format json',
      'monochange step commit-release --commit-backend hosted --hosted-auth oidc',
      'monochange step open-release-request --backend hosted --format json',
    ]);

    for (const call of mockExec.mock.calls) {
      const options = call[2];
      expect(options?.cwd).toBe('.');
      expect(options?.env?.MONOCHANGE_HOSTED_URL).toBe('https://monochange.dev');
      expect(options?.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('request-token');
      expect(options?.env?.GITHUB_TOKEN).toBe('gh-token');
      expect(options?.env?.MONOCHANGE_RELEASE_BACKEND).toBeUndefined();
    }

    expect(mockExec.mock.calls[2]?.[2]?.env?.GITHUB_HEAD_REF).toBe(
      'monochange/release/step-open-release-request',
    );
    expect(mockExec.mock.calls[3]?.[2]?.env?.GITHUB_HEAD_REF).toBe('');
    expect(mockGithub.getOctokit).toHaveBeenCalledWith('gh-token');
    expect(getRef).toHaveBeenCalledWith({
      owner: 'acme',
      ref: 'heads/monochange/release/step-open-release-request',
      repo: 'widgets',
    });
    expect(getCommit).toHaveBeenCalledWith({
      commit_sha: 'release-sha',
      owner: 'acme',
      repo: 'widgets',
    });
    expect(list).toHaveBeenCalledWith({
      base: 'main',
      head: 'acme:monochange/release/step-open-release-request',
      owner: 'acme',
      per_page: 1,
      repo: 'widgets',
      state: 'open',
    });
    expect(outputs()).toEqual({
      'base-branch': 'main',
      'commit-sha': 'release-sha',
      'head-branch': 'monochange/release/step-open-release-request',
      'pull-request-number': '42',
      'pull-request-url': 'https://github.com/acme/widgets/pull/42',
      result: 'success',
      verified: 'true',
    });
  });

  it.each([
    ['https://staging.monochange.dev/', 'https://staging.monochange.dev'],
    ['HTTPS://STAGING.MONOCHANGE.DEV:443/releases/../api///', 'https://staging.monochange.dev/api'],
    ['https://staging.monochange.dev:8443/api/', 'https://staging.monochange.dev:8443/api'],
    ['https://staging.monochange.dev/api/?key=/', 'https://staging.monochange.dev/api?key=/'],
  ])(
    'passes the normalized hosted URL %s and working directory to the CLI',
    async (hostedUrl, expectedUrl) => {
      setInputs({
        'github-token': 'gh-token',
        'hosted-url': hostedUrl,
        'setup-monochange': 'false',
        'working-directory': 'packages/app',
      });

      await runHostedRelease();

      expect(mockResolve).toHaveBeenCalledWith('false');

      for (const call of mockExec.mock.calls) {
        expect(call[2]).toMatchObject({
          cwd: 'packages/app',
          env: { MONOCHANGE_HOSTED_URL: expectedUrl },
        });
      }
    },
  );

  it('reports the planned release without contacting the hosted app in dry-run mode', async () => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', '');
    setInputs({ 'dry-run': 'true' });

    await runHostedRelease();

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockGithub.getOctokit).not.toHaveBeenCalled();
    expect(outputs()).toEqual({
      'base-branch': 'main',
      'head-branch': 'monochange/release/step-open-release-request',
      result: 'dry-run',
    });
  });

  it('runs the repository release command with every release step on the hosted backend', async () => {
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: 'monochange 0.20.0',
    });
    setInputs({ 'github-token': 'gh-token', 'release-command': 'release' });

    await runHostedRelease();

    const calls = mockExec.mock.calls.map(([command, args]) => [command, ...args].join(' '));
    expect(calls).toEqual([
      'monochange run release',
      'monochange step open-release-request --backend hosted --dry-run --format json',
    ]);
    expect(mockExec.mock.calls[0]?.[2]?.env).toMatchObject({
      GITHUB_TOKEN: 'gh-token',
      MONOCHANGE_HOSTED_URL: 'https://monochange.dev',
      MONOCHANGE_RELEASE_BACKEND: 'hosted',
    });
    expect(mockExec.mock.calls[1]?.[2]?.env?.MONOCHANGE_RELEASE_BACKEND).toBeUndefined();
    expect(outputs()).toMatchObject({
      'head-branch': 'monochange/release/step-open-release-request',
      'pull-request-number': '42',
      result: 'success',
      verified: 'true',
    });
  });

  it('passes dry-run to the repository release command', async () => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', '');
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: 'monochange 0.20.1',
    });
    setInputs({ 'dry-run': 'true', 'release-command': 'release-pr' });

    await runHostedRelease();

    const calls = mockExec.mock.calls.map(([command, args]) => [command, ...args].join(' '));
    expect(calls).toEqual([
      'monochange run release-pr --dry-run',
      'monochange step open-release-request --backend hosted --dry-run --format json',
    ]);
    expect(mockGithub.getOctokit).not.toHaveBeenCalled();
    expect(outputs()).toMatchObject({ result: 'dry-run' });
  });

  it('requires monochange 0.20.0 for a repository release command', async () => {
    setInputs({ 'github-token': 'gh-token', 'release-command': 'release' });

    await expect(runHostedRelease()).rejects.toThrow('requires monochange 0.20.0 or newer');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('asks for the id-token permission when the job cannot mint an OIDC token', async () => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', '');

    await expect(runHostedRelease()).rejects.toThrow('permissions: id-token: write');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('requires a GitHub token to read the release back', async () => {
    setInputs({});

    await expect(runHostedRelease()).rejects.toThrow('Input `github-token` is required');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it.each([
    ['not a url', 'must be an absolute URL'],
    ['https://user:password@[', 'must be an absolute URL'],
    ['ftp://monochange.dev', 'must use https'],
    ['http://monochange.dev', 'must use https'],
    ['http://localhost:3000', 'must use https'],
    ['http://127.0.0.1:3000', 'must use https'],
    ['http://[::1]:3000', 'must use https'],
    ['https://user@monochange.dev', 'must not include credentials'],
    ['https://:password@monochange.dev', 'must not include credentials'],
    ['https://user:password@monochange.dev', 'must not include credentials'],
  ])('rejects the hosted URL %s', async (hostedUrl, message) => {
    setInputs({ 'github-token': 'gh-token', 'hosted-url': hostedUrl });

    const release = runHostedRelease();

    await expect(release).rejects.toThrow(message);
    await expect(release).rejects.not.toThrow(hostedUrl);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockGithub.getOctokit).not.toHaveBeenCalled();
  });

  it('rejects HTTP before starting a dry run', async () => {
    setInputs({ 'dry-run': 'true', 'hosted-url': 'http://monochange.dev' });

    await expect(runHostedRelease()).rejects.toThrow('must use https');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('rejects HTTP before running a repository release command', async () => {
    setInputs({
      'github-token': 'gh-token',
      'hosted-url': 'http://monochange.dev',
      'release-command': 'release',
    });

    await expect(runHostedRelease()).rejects.toThrow('must use https');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('rejects a monochange CLI without the hosted backend before preparing', async () => {
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: 'monochange 0.15.0',
    });

    await expect(runHostedRelease()).rejects.toThrow('requires monochange 0.17.0 or newer');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('explains a hosted commit failure with the matching hint', async () => {
    mockExec.mockImplementation(async (_command, args) => {
      if (args.includes('commit-release')) {
        throw new Error(
          'error[config.invalid]: hosted CommitRelease failed with HTTP 404 Not Found: {"message":"no installation"}',
        );
      }

      return RELEASE_REQUEST_JSON;
    });

    await expect(runHostedRelease()).rejects.toThrow('Install the monochange GitHub App');
    expect(mockGithub.getOctokit).not.toHaveBeenCalled();
  });

  it('keeps non-Error CLI failures readable', async () => {
    mockExec.mockRejectedValue('spawn failed');

    await expect(runHostedRelease()).rejects.toThrow('spawn failed');
  });

  it('warns when GitHub lists no open release pull request yet', async () => {
    setOctokit({ pulls: [] });

    await runHostedRelease();

    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('no open pull request'));
    expect(outputs()).toMatchObject({
      'pull-request-number': '',
      'pull-request-url': '',
      result: 'success',
    });
  });

  it('fails when GitHub does not verify the release commit', async () => {
    setOctokit({ verified: false });

    await expect(runHostedRelease()).rejects.toThrow(
      'Release commit release-sha on `monochange/release/step-open-release-request` is not verified by GitHub (reason: valid)',
    );
    expect(outputs()).toMatchObject({ 'commit-sha': 'release-sha', verified: 'false' });
    expect(outputs().result).toBeUndefined();
  });
});

describe('assertHostedReleaseSupport', () => {
  it.each(['monochange 0.17.0', 'monochange 0.17.1', 'monochange 0.18.0', 'monochange 1.0.0'])(
    'accepts %s',
    (version) => {
      expect(() => {
        assertHostedReleaseSupport(version);
      }).not.toThrow();
    },
  );

  it.each(['monochange 0.9.9', 'monochange 0.16.12', 'monochange 0.15.0'])(
    'rejects %s',
    (version) => {
      expect(() => {
        assertHostedReleaseSupport(version);
      }).toThrow('0.17.0 or newer');
    },
  );

  it('checks a custom minimum version', () => {
    expect(() => {
      assertHostedReleaseSupport('monochange 0.19.1', '0.20.0');
    }).toThrow('0.20.0 or newer');
    expect(() => {
      assertHostedReleaseSupport('monochange 0.20.0', '0.20.0');
    }).not.toThrow();
  });

  it('rejects output without a version', () => {
    expect(() => {
      assertHostedReleaseSupport('monochange dev');
    }).toThrow('Could not read a monochange version');
  });
});

describe('explainHostedFailure', () => {
  it('points OIDC token failures at the id-token permission', () => {
    expect(
      explainHostedFailure('hosted CommitRelease OIDC token request failed with status 403'),
    ).toContain('permissions: id-token: write');
  });

  it.each([
    [400, 'repository-relative'],
    [401, 'rejected the OIDC token'],
    [403, 'different repository'],
    [404, 'Install the monochange GitHub App'],
    [409, 'Merge or close the open release pull request'],
    [422, 'must not modify GitHub workflows'],
    [503, 'not configured for hosted releases'],
  ])('adds a hint for HTTP %i', (status, hint) => {
    expect(
      explainHostedFailure(`hosted OpenReleaseRequest failed with HTTP ${status}: {}`),
    ).toContain(hint);
  });

  it('leaves messages without a known status unchanged', () => {
    expect(explainHostedFailure('hosted CommitRelease failed with HTTP 500: boom')).toBe(
      'hosted CommitRelease failed with HTTP 500: boom',
    );
    expect(explainHostedFailure('no markdown changesets found')).toBe(
      'no markdown changesets found',
    );
  });
});

describe('parseReleaseRequestTarget', () => {
  it('reads the release request branches and repository', () => {
    expect(parseReleaseRequestTarget(RELEASE_REQUEST_JSON)).toEqual({
      baseBranch: 'main',
      headBranch: 'monochange/release/step-open-release-request',
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it.each(['not json', '[]', '{"release_request":null}'])(
    'asks for a [source] configuration when %s has no release request',
    (stdout) => {
      expect(() => parseReleaseRequestTarget(stdout)).toThrow('Configure `[source]`');
    },
  );

  it.each([
    ['missing', { base_branch: 'main', owner: 'acme', repo: 'widgets' }],
    ['empty', { base_branch: 'main', head_branch: '', owner: 'acme', repo: 'widgets' }],
  ])('rejects a %s head branch', (_label, request) => {
    expect(() => parseReleaseRequestTarget(JSON.stringify({ release_request: request }))).toThrow(
      '`release_request.head_branch`',
    );
  });
});
