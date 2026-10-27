import { getOctokit } from '@actions/github';
import { describe, expect, it, vi } from 'vitest';

import { evaluateChecks } from './checks';
import { collectStatuses } from './statuses';

/** Supplies GitHub responses to the real client without making network requests. */
function statusClient(...pages: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();

  for (const page of pages) {
    fetch.mockResolvedValueOnce(Response.json(page));
  }

  const octokit = getOctokit('test-token', { request: { fetch } });

  return { octokit, owner: 'acme', repo: 'widgets', ref: 'candidate-sha', fetch };
}

/** Builds distinct passing contexts so a security failure lands after the first page. */
function passingStatuses(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    context: `ci-${index + offset}`,
    state: 'success',
    target_url: null,
  }));
}

describe('collectStatuses', () => {
  it('preserves an allowed blocker after collecting three pages', async () => {
    const client = statusClient(
      { total_count: 201, state: 'failure', statuses: passingStatuses(100) },
      {
        total_count: 201,
        state: 'failure',
        statuses: passingStatuses(100, 100),
      },
      {
        total_count: 201,
        state: 'failure',
        statuses: [{ context: 'release-blocker', state: 'failure', target_url: null }],
      },
    );

    const checks = await collectStatuses(client);

    expect(checks).toHaveLength(201);
    expect(
      evaluateChecks({
        checks,
        requireGreenChecks: true,
        requiredFailingCheck: 'release-blocker',
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(client.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([1, 100])('accepts %i passing contexts without an extra page', async (count) => {
    const client = statusClient({
      total_count: count,
      state: 'success',
      statuses: passingStatuses(count),
    });

    const checks = await collectStatuses(client);

    expect(checks).toHaveLength(count);
    expect(checks[0]).toEqual({
      kind: 'status',
      name: 'ci-0',
      state: 'success',
      detailsUrl: undefined,
    });
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  it('allows an empty legacy-status set with its documented pending aggregate', async () => {
    const client = statusClient({ total_count: 0, state: 'pending', statuses: [] });

    await expect(collectStatuses(client)).resolves.toEqual([]);
  });

  it.each(['failure', 'error', 'pending'])(
    'rejects a later-page %s beside the allowed blocker',
    async (state) => {
      const client = statusClient(
        {
          total_count: 101,
          state: 'failure',
          statuses: [
            { context: 'release-blocker', state: 'failure', target_url: null },
            ...passingStatuses(99),
          ],
        },
        {
          total_count: 101,
          state: 'failure',
          statuses: [{ context: 'security', state, target_url: 'https://ci.example/security' }],
        },
      );

      const checks = await collectStatuses(client);
      const evaluation = evaluateChecks({
        checks,
        requireGreenChecks: true,
        requiredFailingCheck: 'release-blocker',
      });

      expect(evaluation.ok).toBe(false);
      expect(evaluation.errors.join('\n')).toContain('security');
      expect(checks).toContainEqual({
        kind: 'status',
        name: 'security',
        state: state === 'pending' ? 'pending' : 'failure',
        detailsUrl: 'https://ci.example/security',
      });
      expect(client.fetch).toHaveBeenNthCalledWith(
        1,
        'https://api.github.com/repos/acme/widgets/commits/candidate-sha/status?per_page=100&page=1',
        expect.anything(),
      );
      expect(client.fetch).toHaveBeenNthCalledWith(
        2,
        'https://api.github.com/repos/acme/widgets/commits/candidate-sha/status?per_page=100&page=2',
        expect.anything(),
      );
    },
  );

  it('rejects a pending aggregate through the merge policy', async () => {
    const client = statusClient({
      total_count: 1,
      state: 'pending',
      statuses: [{ context: 'security', state: 'pending', target_url: null }],
    });
    const checks = await collectStatuses(client);

    expect(
      evaluateChecks({
        checks,
        requireGreenChecks: true,
        requiredFailingCheck: undefined,
      }).ok,
    ).toBe(false);
  });

  it.each([0, 2])('rejects a reported count of %i for one returned status', async (totalCount) => {
    const client = statusClient({
      total_count: totalCount,
      state: 'success',
      statuses: passingStatuses(1),
    });

    await expect(collectStatuses(client)).rejects.toThrow(
      'Could not collect every commit status context',
    );
  });

  it('rejects a truncated later page', async () => {
    const client = statusClient(
      { total_count: 101, state: 'success', statuses: passingStatuses(100) },
      { total_count: 101, state: 'success', statuses: [] },
    );

    await expect(collectStatuses(client)).rejects.toThrow(
      'Could not collect every commit status context',
    );
  });

  it('rejects overlapping pages even when the collected count matches', async () => {
    const client = statusClient(
      { total_count: 101, state: 'success', statuses: passingStatuses(100) },
      { total_count: 101, state: 'success', statuses: passingStatuses(1) },
    );

    await expect(collectStatuses(client)).rejects.toThrow(
      'Could not collect every commit status context',
    );
  });

  it.each([
    { total_count: 102, state: 'success' },
    { total_count: 101, state: 'pending' },
  ])('rejects metadata changing between pages: %j', async (metadata) => {
    const client = statusClient(
      { total_count: 101, state: 'success', statuses: passingStatuses(100) },
      { ...metadata, statuses: [] },
    );

    await expect(collectStatuses(client)).rejects.toThrow(
      'Commit statuses changed while paginating',
    );
  });

  it.each(['pending', 'failure'])('rejects an unexplained %s aggregate', async (state) => {
    const client = statusClient({ total_count: 1, state, statuses: passingStatuses(1) });

    await expect(collectStatuses(client)).rejects.toThrow('disagree with the aggregate state');
  });

  it('rejects an unknown status state', async () => {
    const client = statusClient({
      total_count: 1,
      state: 'success',
      statuses: [{ context: 'security', state: 'unknown', target_url: null }],
    });

    await expect(collectStatuses(client)).rejects.toThrow('Unknown commit status state');
  });

  it('propagates a later-page API failure without returning partial checks', async () => {
    const client = statusClient({
      total_count: 101,
      state: 'failure',
      statuses: passingStatuses(100),
    });
    client.fetch.mockResolvedValueOnce(Response.json({ message: 'Unavailable' }, { status: 503 }));

    await expect(collectStatuses(client)).rejects.toThrow('Unavailable');
  });
});
