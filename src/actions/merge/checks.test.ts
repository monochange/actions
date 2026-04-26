import { describe, expect, it } from 'vitest';

import { evaluateChecks, renderChecks, type ActionCheck } from './checks';

function check(
  name: string,
  state: ActionCheck['state'],
  kind: ActionCheck['kind'] = 'check-run',
): ActionCheck {
  return {
    kind,
    name,
    state,
    detailsUrl: undefined,
  };
}

describe('evaluateChecks', () => {
  it('returns ok when require-green-checks is false', () => {
    const result = evaluateChecks({
      checks: [check('test', 'failure')],
      requireGreenChecks: false,
      requiredFailingCheck: undefined,
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('errors when no checks are found', () => {
    const result = evaluateChecks({
      checks: [],
      requireGreenChecks: true,
      requiredFailingCheck: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('No checks were found for the pull request head commit.');
  });

  it('fails when there are cancelled checks', () => {
    const result = evaluateChecks({
      checks: [check('test', 'cancelled')],
      requireGreenChecks: true,
      requiredFailingCheck: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/cancelled checks/);
  });

  it('allows one configured blocker failure', () => {
    const result = evaluateChecks({
      checks: [
        check('release-pr-manual-merge-blocker', 'failure'),
        check('test', 'success'),
        check('lint', 'success'),
      ],
      requiredFailingCheck: 'release-pr-manual-merge-blocker',
      requireGreenChecks: true,
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('fails when there are pending checks', () => {
    const result = evaluateChecks({
      checks: [check('release-pr-manual-merge-blocker', 'failure'), check('test', 'pending')],
      requiredFailingCheck: 'release-pr-manual-merge-blocker',
      requireGreenChecks: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/pending checks/);
  });

  it('fails when an unexpected check is failing', () => {
    const result = evaluateChecks({
      checks: [check('release-pr-manual-merge-blocker', 'failure'), check('test', 'failure')],
      requiredFailingCheck: 'release-pr-manual-merge-blocker',
      requireGreenChecks: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/failing checks/);
  });

  it('fails when the blocker is missing', () => {
    const result = evaluateChecks({
      checks: [check('test', 'success')],
      requiredFailingCheck: 'release-pr-manual-merge-blocker',
      requireGreenChecks: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Expected exactly one failing check/);
  });
});

describe('renderChecks', () => {
  it('renders checks as markdown', () => {
    const checks: ActionCheck[] = [
      { kind: 'check-run', name: 'ci', state: 'success', detailsUrl: undefined },
      { kind: 'status', name: 'lint', state: 'failure', detailsUrl: 'https://example.com' },
    ];
    const result = renderChecks(checks);

    expect(result).toContain('- [success] ci (check-run)');
    expect(result).toContain('- [failure] lint (status)');
  });
});
