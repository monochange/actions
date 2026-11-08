import * as core from '@actions/core';

import { exec } from '../../shared/exec';
import { safeJsonParse } from '../../shared/json';
import type { CiGitHubContext } from './github-context';
import type { CiInputs } from './inputs';
import { failureDetail, isRecord, pushValue } from './support';

export type VerifyConclusion = 'failure' | 'skipped' | 'success';

interface PendingVerification {
  conclusion: VerifyConclusion;
  jobId: string;
  priorDecision: boolean;
}

/**
 * Record one `monochange ci verify` outcome per gated workflow job.
 *
 * `needs` is the workflow's `${{ toJSON(needs) }}` map and `decisions` is the
 * gate's `decisions` output. Jobs missing from either map are not verifiable
 * and are skipped; `cancelled` runs are skipped because a cancelled job says
 * nothing about whether the gate was right.
 */
export async function runVerify(
  command: string,
  inputs: CiInputs,
  context: CiGitHubContext,
): Promise<void> {
  const pending = pendingVerifications(parseNeeds(inputs.needs), parseDecisions(inputs.decisions));

  for (const job of pending) {
    const result = await exec(
      command,
      buildVerifyArgs({
        conclusion: job.conclusion,
        context,
        inputs,
        jobId: job.jobId,
        priorDecision: job.priorDecision,
      }),
      { cwd: inputs.workingDirectory },
    );

    if (result.exitCode !== 0) {
      throw new Error(`monochange ci verify failed for \`${job.jobId}\`: ${failureDetail(result)}`);
    }

    core.info(result.stdout.trim());
  }

  core.setOutput('result', 'success');
}

/**
 * Work out which workflow jobs can be verified.
 *
 * A job is verifiable when the gate produced a decision for it and its GitHub
 * result maps onto a CLI conclusion. `cancelled` runs say nothing about the
 * gate, so they are skipped rather than recorded as a failure.
 */
function pendingVerifications(
  needs: Record<string, string>,
  decisions: Record<string, boolean>,
): PendingVerification[] {
  const pending: PendingVerification[] = [];

  for (const [jobId, jobResult] of Object.entries(needs)) {
    const priorDecision = decisions[jobId];

    if (priorDecision !== undefined) {
      const conclusion = mapConclusion(jobResult);

      if (conclusion === undefined) {
        core.info(`Skipping verify for \`${jobId}\`: result \`${jobResult}\` is not verifiable.`);
      } else {
        pending.push({ conclusion, jobId, priorDecision });
      }
    }
  }

  return pending;
}

export function buildVerifyArgs(options: {
  conclusion: VerifyConclusion;
  context: CiGitHubContext;
  inputs: CiInputs;
  jobId: string;
  priorDecision: boolean;
}): string[] {
  const { conclusion, context, inputs, jobId, priorDecision } = options;
  const args = [
    'ci',
    'verify',
    '--job',
    jobId,
    '--conclusion',
    conclusion,
    '--prior-decision',
    priorDecision ? 'y' : 'n',
  ];

  pushValue(args, '--commit', context.commit);
  pushValue(args, '--branch', context.branch);
  pushValue(args, '--token', inputs.authToken);

  if (inputs.requireAuth) {
    args.push('--require-auth');
  }

  pushValue(args, '--repo-id', inputs.repoId);

  return args;
}

function parseNeeds(value: string): Record<string, string> {
  const parsed = parseJsonObject(value, 'needs');
  const results: Record<string, string> = {};

  for (const [jobId, entry] of Object.entries(parsed)) {
    const result = isRecord(entry) ? entry.result : undefined;

    if (typeof result !== 'string') {
      throw new Error(`Input \`needs\` entry \`${jobId}\` must be an object with a string result.`);
    }

    results[jobId] = result;
  }

  return results;
}

function parseDecisions(value: string): Record<string, boolean> {
  const parsed = parseJsonObject(value, 'decisions');
  const decisions: Record<string, boolean> = {};

  for (const [jobId, decision] of Object.entries(parsed)) {
    if (typeof decision !== 'boolean') {
      throw new Error(`Input \`decisions\` entry \`${jobId}\` must be a boolean.`);
    }

    decisions[jobId] = decision;
  }

  return decisions;
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  const parsed: unknown = safeJsonParse(value);

  if (!isRecord(parsed)) {
    throw new Error(`Input \`${name}\` must be a JSON object.`);
  }

  return parsed;
}

function mapConclusion(result: string): VerifyConclusion | undefined {
  switch (result.trim().toLowerCase()) {
    case 'failure': {
      return 'failure';
    }
    case 'skipped': {
      return 'skipped';
    }
    case 'success': {
      return 'success';
    }
    default: {
      return undefined;
    }
  }
}
