export interface ActionCheck {
  kind: 'check-run' | 'status';
  name: string;
  state: 'success' | 'pending' | 'failure' | 'cancelled' | 'skipped';
  detailsUrl: string | undefined;
}

export interface CheckEvaluation {
  ok: boolean;
  errors: string[];
}

export function evaluateChecks(options: {
  checks: ActionCheck[];
  requiredFailingCheck: string | undefined;
  requireGreenChecks: boolean;
}): CheckEvaluation {
  const { checks, requiredFailingCheck, requireGreenChecks } = options;

  if (!requireGreenChecks) {
    return { ok: true, errors: [] };
  }

  if (checks.length === 0) {
    return {
      ok: false,
      errors: ['No checks were found for the pull request head commit.'],
    };
  }

  const pendingChecks = checks.filter((check) => check.state === 'pending');
  const cancelledChecks = checks.filter((check) => check.state === 'cancelled');
  const failingChecks = checks.filter((check) => check.state === 'failure');
  const blockerFailures = requiredFailingCheck
    ? failingChecks.filter((check) => check.name === requiredFailingCheck)
    : [];
  const unexpectedFailures = requiredFailingCheck
    ? failingChecks.filter((check) => check.name !== requiredFailingCheck)
    : failingChecks;

  const errors: string[] = [];

  if (requiredFailingCheck && blockerFailures.length !== 1) {
    errors.push(
      `Expected exactly one failing check named \`${requiredFailingCheck}\`, found ${blockerFailures.length}.`,
    );
  }

  if (pendingChecks.length > 0) {
    errors.push(
      `Pull request still has pending checks: ${pendingChecks.map((check) => `\`${check.name}\``).join(', ')}.`,
    );
  }

  if (cancelledChecks.length > 0) {
    errors.push(
      `Pull request has cancelled checks: ${cancelledChecks.map((check) => `\`${check.name}\``).join(', ')}.`,
    );
  }

  if (unexpectedFailures.length > 0) {
    errors.push(
      `Pull request has failing checks: ${unexpectedFailures.map((check) => `\`${check.name}\``).join(', ')}.`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function renderChecks(checks: ActionCheck[]): string {
  return checks.map((check) => `- [${check.state}] ${check.name} (${check.kind})`).join('\n');
}
