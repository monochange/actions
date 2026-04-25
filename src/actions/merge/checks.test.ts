import { describe, expect, it } from 'vitest';

import { evaluateChecks, type ActionCheck } from './checks';

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
