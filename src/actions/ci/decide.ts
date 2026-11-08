import * as core from '@actions/core';

import { exec, type ExecResult } from '../../shared/exec';
import { safeJsonParse } from '../../shared/json';
import type { CiGitHubContext } from './github-context';
import type { CiInputs } from './inputs';
import { errorMessage, failureDetail, isRecord, pushValue } from './support';

interface DecideOutputs {
  affectedPackages: string;
  decisions: string;
  runAll: string;
}

/**
 * Run `monochange ci decide` for every configured `[ci.jobs]` id.
 *
 * The CLI writes `$GITHUB_OUTPUT` itself. The action also republishes the same
 * values with `core.setOutput` so `steps.<id>.outputs.decisions` is populated
 * even when the CLI's file write is followed by a later step output.
 */
export async function runDecide(
  command: string,
  inputs: CiInputs,
  context: CiGitHubContext,
): Promise<void> {
  let result: ExecResult;

  try {
    result = await exec(command, buildDecideArgs(inputs, context), {
      cwd: inputs.workingDirectory,
    });
  } catch (error) {
    handleDecideFailure(inputs, errorMessage(error));

    return;
  }

  const outputs = result.exitCode === 0 ? parseDecideOutputs(result.stdout) : undefined;

  if (outputs === undefined) {
    handleDecideFailure(inputs, failureDetail(result));

    return;
  }

  core.setOutput('decisions', outputs.decisions);
  core.setOutput('affected-packages', outputs.affectedPackages);
  core.setOutput('run-all', outputs.runAll);
  core.setOutput('result', 'success');
}

/**
 * Apply `on-error` after a decide failure.
 *
 * `run-all` fails open: the gate runs every job and exits successfully because
 * GitHub skips dependent jobs when a gate fails, and a skipped required check
 * counts as passing. `fail` keeps the failure loud.
 */
function handleDecideFailure(inputs: CiInputs, detail: string): void {
  if (inputs.onError === 'run-all') {
    core.error(
      `monochange ci decide did not produce usable outputs (${detail}); running every job.`,
    );
    setRunAllOutputs();

    return;
  }

  throw new Error(`monochange ci decide failed: ${detail}`);
}

export function buildDecideArgs(inputs: CiInputs, context: CiGitHubContext): string[] {
  const args = [
    'ci',
    'decide',
    '--format',
    'github-outputs',
    '--on-error',
    inputs.onError,
    '--base',
    resolveBase(inputs.base, context),
    '--head',
    inputs.head === '' ? 'HEAD' : inputs.head,
  ];

  pushValue(args, '--event', context.eventName);
  pushValue(args, '--branch', context.branch);
  pushValue(args, '--ref', context.ref);
  pushValue(args, '--commit', context.commit);

  for (const label of context.labels) {
    args.push('--labels', label);
  }

  pushValue(args, '--commit-message', context.commitMessage);
  pushValue(args, '--provider', inputs.provider);
  pushValue(args, '--model', inputs.model);
  pushValue(args, '--api-key', inputs.apiKey);
  pushValue(args, '--api-url', inputs.apiUrl);
  pushValue(args, '--account-id', inputs.cloudflareAccountId);
  pushValue(args, '--token', inputs.authToken);

  if (inputs.requireAuth) {
    args.push('--require-auth');
  }

  pushValue(args, '--repo-id', inputs.repoId);

  return args;
}

/**
 * Resolve the diff base for `ci decide`.
 *
 * A `pull_request` checkout is GitHub's merge commit, so its first parent is
 * the base. A push uses the event's `before` SHA unless that is the all-zero
 * deletion marker, and everything else compares against the default branch.
 */
export function resolveBase(base: string, context: CiGitHubContext): string {
  if (base !== '') {
    return base;
  }

  if (context.eventName === 'pull_request') {
    return 'HEAD^1';
  }

  if (context.eventName === 'push' && context.before !== '' && !/^0+$/u.test(context.before)) {
    return context.before;
  }

  return `origin/${context.defaultBranch}`;
}

function parseDecideOutputs(stdout: string): DecideOutputs | undefined {
  const values = new Map<string, string>();

  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=');

    if (separator > 0) {
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }

  const decisions = values.get('decisions');
  const affectedPackages = values.get('affected-packages');
  const runAll = values.get('run-all');

  if (
    decisions === undefined ||
    affectedPackages === undefined ||
    runAll === undefined ||
    !isDecisionMap(decisions) ||
    !isStringArrayJson(affectedPackages) ||
    (runAll !== 'true' && runAll !== 'false')
  ) {
    return undefined;
  }

  return { affectedPackages, decisions, runAll };
}

function setRunAllOutputs(): void {
  core.setOutput('decisions', '{}');
  core.setOutput('affected-packages', '[]');
  core.setOutput('run-all', 'true');
  core.setOutput('result', 'success');
}

function isDecisionMap(value: string): boolean {
  const parsed: unknown = safeJsonParse(value);

  return isRecord(parsed) && Object.values(parsed).every((entry) => typeof entry === 'boolean');
}

function isStringArrayJson(value: string): boolean {
  const parsed: unknown = safeJsonParse(value);

  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string');
}
