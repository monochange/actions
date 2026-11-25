import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import { isRetryableError, RELEASE_RECORD_FILTER, runPublishDraftReleases } from './index';

vi.mock('@actions/core');
vi.mock('../../shared/exec', () => ({ exec: vi.fn() }));
vi.mock('./delay', () => ({ sleep: vi.fn() }));

import { exec, type ExecResult } from '../../shared/exec';
import { sleep } from './delay';

const mockCore = vi.mocked(core);
const mockExec = vi.mocked(exec);
const mockSleep = vi.mocked(sleep);

const FIXTURES = 'src/actions/publish-draft-releases/fixtures';
const WITH_RECORD = `${FIXTURES}/with-record`;
const OTHER_RECORD = `${FIXTURES}/other-record`;
const NO_RECORD = `${FIXTURES}/no-record`;

function setInputs(values: Record<string, string>): void {
  mockCore.getInput.mockImplementation((name) => values[name] ?? '');
}

function baseInputs(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'github-token': 'token',
    'publish-related': 'false',
    'release-tag': 'v1.0.0',
    repository: 'owner/repo',
    ...overrides,
  };
}

function ok(stdout: string): ExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string, exitCode = 1, stdout = ''): ExecResult {
  return { exitCode, stdout, stderr };
}

function view(isDraft: boolean): ExecResult {
  return ok(JSON.stringify({ isDraft, tagName: 'release' }));
}

function lastCall(command: string, subcommand: string): string[] {
  const calls = mockExec.mock.calls.filter(
    ([calledCommand, args]) => calledCommand === command && args[1] === subcommand,
  );
  const call = calls.at(-1);

  if (!call) {
    throw new Error(`No ${command} ${subcommand} call was made.`);
  }

  return call[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCore.getInput.mockReturnValue('');
  setInputs(baseInputs());
});

describe('runPublishDraftReleases', () => {
  it('leaves an already public release untouched', async () => {
    mockExec.mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['release', 'view', 'v1.0.0', '--json', 'tagName,isDraft', '--repo', 'owner/repo'],
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: 'token' }) }),
    );
    expect(mockCore.setSecret).toHaveBeenCalledWith('token');
    expect(mockExec.mock.calls[0]?.[2]?.env?.PATH).toBe(process.env.PATH);
    expect(mockCore.info).toHaveBeenCalledWith(
      'Release v1.0.0 is already public; nothing to publish.',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('target-tags', '["v1.0.0"]');
    expect(mockCore.setOutput).toHaveBeenCalledWith('published-tags', '[]');
    expect(mockCore.setOutput).toHaveBeenCalledWith('failed-tags', '[]');
  });

  it('publishes a draft and marks the primary release latest', async () => {
    mockExec
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(lastCall('gh', 'edit')).toEqual([
      'release',
      'edit',
      'v1.0.0',
      '--draft=false',
      '--latest',
      '--repo',
      'owner/repo',
    ]);
    expect(mockCore.info).toHaveBeenCalledWith('Published release v1.0.0.');
    expect(mockCore.setOutput).toHaveBeenCalledWith('published-tags', '["v1.0.0"]');
  });

  it('retries a 500 from the lookup and then publishes', async () => {
    mockExec
      .mockResolvedValueOnce(fail('gh: Internal Server Error (HTTP 500)'))
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockSleep.mock.calls).toEqual([[10_000]]);
    expect(mockCore.warning).toHaveBeenCalledWith(
      'Attempt 1 to publish release v1.0.0 failed: gh: Internal Server Error (HTTP 500). Retrying in 10s.',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('published-tags', '["v1.0.0"]');
  });

  it('retries a 500 from the edit and then publishes', async () => {
    mockExec
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(fail('gh: Internal Server Error (HTTP 500)'))
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockSleep.mock.calls).toEqual([[10_000]]);
    expect(mockCore.setOutput).toHaveBeenCalledWith('published-tags', '["v1.0.0"]');
  });

  it('stops after the attempt limit and fails the primary release', async () => {
    setInputs(baseInputs({ 'max-attempts': '3' }));
    mockExec
      .mockResolvedValueOnce(fail('gh: Internal Server Error (HTTP 500)'))
      .mockResolvedValueOnce(fail('gh: Bad Gateway (HTTP 502)'))
      .mockResolvedValueOnce(fail('gh: Service Unavailable (HTTP 503)'));

    await expect(runPublishDraftReleases()).rejects.toThrow(
      'The primary release v1.0.0 is not public. Failed releases: v1.0.0 (gh: Service Unavailable (HTTP 503)).',
    );

    expect(mockSleep.mock.calls).toEqual([[10_000], [20_000]]);
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'failed');
    expect(mockCore.setOutput).toHaveBeenCalledWith('failed-tags', '["v1.0.0"]');
  });

  it('fails at once for a 404 on the primary release', async () => {
    mockExec.mockResolvedValueOnce(fail('gh: Not Found (HTTP 404)'));

    await expect(runPublishDraftReleases()).rejects.toThrow(
      'The primary release v1.0.0 is not public.',
    );

    expect(mockSleep).not.toHaveBeenCalled();
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockCore.warning).toHaveBeenCalledWith('Release v1.0.0 does not exist.');
    expect(mockCore.setOutput).toHaveBeenCalledWith('failed-tags', '["v1.0.0"]');
  });

  it('does not retry a 422 response from the edit', async () => {
    mockExec
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(fail('gh: Validation Failed (HTTP 422)'));

    await expect(runPublishDraftReleases()).rejects.toThrow('HTTP 422');

    expect(mockSleep).not.toHaveBeenCalled();
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('warns and continues when a secondary release is missing', async () => {
    setInputs(
      baseInputs({
        'publish-related': 'true',
        'working-directory': OTHER_RECORD,
      }),
    );
    mockExec
      .mockResolvedValueOnce(ok('forks/v5.0.1\n'))
      .mockResolvedValueOnce(view(false))
      .mockResolvedValueOnce(fail('gh: Not Found (HTTP 404)'));

    await runPublishDraftReleases();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Release forks/v5.0.1 does not exist; skipping it.',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('failed-tags', '[]');
  });

  it('publishes every release target and marks only the primary latest', async () => {
    setInputs(
      baseInputs({
        'publish-related': 'true',
        'working-directory': WITH_RECORD,
      }),
    );
    mockExec
      .mockResolvedValueOnce(ok('v1.0.0\nforks/v5.0.1\nv1.0.0\n'))
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(view(false))
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    const editCalls = mockExec.mock.calls.filter(([, args]) => args[1] === 'edit');

    expect(editCalls).toHaveLength(2);
    expect(editCalls[0]?.[1]).toEqual([
      'release',
      'edit',
      'v1.0.0',
      '--draft=false',
      '--latest',
      '--repo',
      'owner/repo',
    ]);
    expect(editCalls[1]?.[1]).toEqual([
      'release',
      'edit',
      'forks/v5.0.1',
      '--draft=false',
      '--latest=false',
      '--repo',
      'owner/repo',
    ]);
    expect(mockCore.setOutput).toHaveBeenCalledWith('target-tags', '["v1.0.0","forks/v5.0.1"]');
    expect(mockCore.setOutput).toHaveBeenCalledWith('published-tags', '["v1.0.0","forks/v5.0.1"]');
  });

  it('publishes only the primary release when no record matches the tag', async () => {
    setInputs(
      baseInputs({
        'publish-related': 'true',
        'working-directory': OTHER_RECORD,
      }),
    );
    mockExec.mockResolvedValueOnce(ok('')).mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockCore.info).toHaveBeenCalledWith(
      'No monochange release record lists v1.0.0; publishing only the primary release.',
    );
    expect(mockExec.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
  });

  it('publishes only the primary release when no record directory exists', async () => {
    setInputs(
      baseInputs({
        'publish-related': 'true',
        'working-directory': NO_RECORD,
      }),
    );
    mockExec.mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockCore.info).toHaveBeenCalledWith(
      'No monochange release record found; publishing only the primary release.',
    );
    expect(mockExec.mock.calls.some(([command]) => command === 'jq')).toBe(false);
  });

  it('warns when jq exits non-zero', async () => {
    setInputs(
      baseInputs({
        'publish-related': 'true',
        'working-directory': WITH_RECORD,
      }),
    );
    mockExec
      .mockResolvedValueOnce(fail('jq: error: syntax error'))
      .mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Could not read the monochange release record; publishing only the primary release: jq: error: syntax error',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('warns with the exit code when jq fails without output', async () => {
    setInputs(
      baseInputs({
        'publish-related': 'true',
        'working-directory': WITH_RECORD,
      }),
    );
    mockExec.mockResolvedValueOnce(fail('', 3)).mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Could not read the monochange release record; publishing only the primary release: jq exited with code 3.',
    );
  });

  it('warns when jq throws an error', async () => {
    setInputs(
      baseInputs({
        'publish-related': 'true',
        'working-directory': WITH_RECORD,
      }),
    );
    mockExec
      .mockRejectedValueOnce(new Error('Unable to locate executable file: jq'))
      .mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Could not read the monochange release record; publishing only the primary release: Unable to locate executable file: jq',
    );
  });

  it('warns when jq rejects with a non-Error value', async () => {
    setInputs(
      baseInputs({
        'publish-related': 'true',
        'working-directory': WITH_RECORD,
      }),
    );
    mockExec.mockRejectedValueOnce('jq exploded').mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Could not read the monochange release record; publishing only the primary release: jq exploded',
    );
  });

  it('fails when gh cannot be executed', async () => {
    mockExec.mockRejectedValueOnce(new Error('Unable to locate executable file: gh'));

    await expect(runPublishDraftReleases()).rejects.toThrow('Unable to locate executable file: gh');

    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('fails when the edit cannot be executed', async () => {
    mockExec.mockResolvedValueOnce(view(true)).mockRejectedValueOnce(new Error('gh crashed'));

    await expect(runPublishDraftReleases()).rejects.toThrow('gh crashed');
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it.each(['not json', '{"isDraft":"false"}', 'null'])(
    'fails when the release lookup returns %s',
    async (stdout) => {
      mockExec.mockResolvedValueOnce(ok(stdout));

      await expect(runPublishDraftReleases()).rejects.toThrow(
        'Could not read the draft state of release v1.0.0 from gh output.',
      );
      expect(mockSleep).not.toHaveBeenCalled();
    },
  );

  it('fails when the release disappears after publishing', async () => {
    setInputs(baseInputs({ 'max-attempts': '1' }));
    mockExec
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(fail('gh: Not Found (HTTP 404)'));

    await expect(runPublishDraftReleases()).rejects.toThrow(
      'Release v1.0.0 was not found after publishing.',
    );
  });

  it('retries while the release still reports a draft', async () => {
    setInputs(baseInputs({ 'max-attempts': '2' }));
    mockExec
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(view(true));

    await expect(runPublishDraftReleases()).rejects.toThrow(
      'Release v1.0.0 is still a draft after publishing.',
    );

    expect(mockSleep.mock.calls).toEqual([[10_000]]);
  });

  it('retries when the confirmation lookup fails', async () => {
    setInputs(baseInputs({ 'max-attempts': '1' }));
    mockExec
      .mockResolvedValueOnce(view(true))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(fail('gh: Internal Server Error (HTTP 500)'));

    await expect(runPublishDraftReleases()).rejects.toThrow('HTTP 500');
  });

  it('warns but succeeds when only a secondary release fails', async () => {
    setInputs(
      baseInputs({
        'max-attempts': '1',
        'publish-related': 'true',
        'working-directory': WITH_RECORD,
      }),
    );
    mockExec
      .mockResolvedValueOnce(ok('forks/v5.0.1\n'))
      .mockResolvedValueOnce(view(false))
      .mockResolvedValueOnce(fail('gh: Internal Server Error (HTTP 500)'));

    await runPublishDraftReleases();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Could not publish release forks/v5.0.1: gh: Internal Server Error (HTTP 500)',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
    expect(mockCore.setOutput).toHaveBeenCalledWith('failed-tags', '["forks/v5.0.1"]');
  });

  it('names every failed release when the primary fails', async () => {
    setInputs(
      baseInputs({
        'max-attempts': '1',
        'publish-related': 'true',
        'working-directory': WITH_RECORD,
      }),
    );
    mockExec
      .mockResolvedValueOnce(ok('forks/v5.0.1\n'))
      .mockResolvedValueOnce(fail('gh: Internal Server Error (HTTP 500)'))
      .mockResolvedValueOnce(fail('gh: Bad Gateway (HTTP 502)'));

    await expect(runPublishDraftReleases()).rejects.toThrow(
      'Failed releases: v1.0.0 (gh: Internal Server Error (HTTP 500)); forks/v5.0.1 (gh: Bad Gateway (HTTP 502)).',
    );

    expect(mockCore.setOutput).toHaveBeenCalledWith('failed-tags', '["v1.0.0","forks/v5.0.1"]');
  });

  it('uses a fallback message when the lookup fails without output', async () => {
    mockExec.mockResolvedValueOnce(fail(''));

    await expect(runPublishDraftReleases()).rejects.toThrow('gh release view v1.0.0 failed.');
  });

  it('uses a fallback message when the edit fails without output', async () => {
    mockExec.mockResolvedValueOnce(view(true)).mockResolvedValueOnce(fail(''));

    await expect(runPublishDraftReleases()).rejects.toThrow('gh release edit v1.0.0 failed.');
  });

  it('reads stdout when the error output is empty', async () => {
    setInputs(baseInputs({ 'max-attempts': '1' }));
    mockExec.mockResolvedValueOnce(fail('', 1, 'gh: HTTP 500'));

    await expect(runPublishDraftReleases()).rejects.toThrow('gh: HTTP 500');
  });

  it('requires a release tag', async () => {
    setInputs({});

    await expect(runPublishDraftReleases()).rejects.toThrow('Input `release-tag` is required.');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejects max-attempts %s', async (value) => {
    setInputs(baseInputs({ 'max-attempts': value }));

    await expect(runPublishDraftReleases()).rejects.toThrow(
      `Input \`max-attempts\` must be a positive integer, received \`${value}\`.`,
    );
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('uses the default attempts and no repository or token when inputs are absent', async () => {
    setInputs({ 'release-tag': 'v1.0.0', 'working-directory': NO_RECORD });
    mockExec.mockResolvedValueOnce(view(false));

    await runPublishDraftReleases();

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['release', 'view', 'v1.0.0', '--json', 'tagName,isDraft'],
      {},
    );
    expect(mockCore.setSecret).not.toHaveBeenCalled();
  });
});

describe('isRetryableError', () => {
  it.each([
    ['gh: Internal Server Error (HTTP 500)', true],
    ['gh: Bad Gateway (HTTP 502)', true],
    ['gh: Service Unavailable (HTTP 503)', true],
    ['gh: Too Many Requests (HTTP 429)', true],
    ['gh: API rate limit exceeded for user (HTTP 403)', true],
    ['You have exceeded a secondary rate limit.', true],
    ['gh: Not Found (HTTP 404)', false],
    ['gh: Validation Failed (HTTP 422)', false],
    ['gh: Forbidden (HTTP 403)', false],
    ['dial tcp 140.82.112.6:443: connect: connection reset by peer', true],
    ['TLS handshake timeout', true],
    ['something unexpected', false],
  ])('classifies %s as retryable=%s', (message, retryable) => {
    expect(isRetryableError(message)).toBe(retryable);
  });
});

describe('release record jq filter', () => {
  const hasJq = spawnSync('jq', ['--version']).status === 0;
  const record = join(WITH_RECORD, '.monochange', 'releases', 'rel_1', 'release.json');

  it.skipIf(!hasJq)('selects only released targets from a matching record', () => {
    const result = spawnSync(
      'jq',
      ['-r', '--arg', 'tag', 'v1.0.0', RELEASE_RECORD_FILTER, '--', record],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['v1.0.0', 'forks/v5.0.1']);
  });

  it.skipIf(!hasJq)('selects nothing from a record for another tag', () => {
    const result = spawnSync(
      'jq',
      ['-r', '--arg', 'tag', 'v1.0.0', RELEASE_RECORD_FILTER, '--', record],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('skip/v1.0.0');
  });
});
