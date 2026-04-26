import * as core from '@actions/core';
import * as github from '@actions/github';

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

export interface ChangesetPolicyInputs {
  setupMonochange: string;
  githubToken: string;
  changedPaths: string | undefined;
  labels: string | undefined;
  skipLabels: string | undefined;
  commentOnFailure: boolean;
  repository: string;
  dryRun: boolean;
  debug: boolean;
}

function readInputs(): ChangesetPolicyInputs {
  return {
    changedPaths: getOptionalInput('changed-paths'),
    commentOnFailure: getBoolean('comment-on-failure'),
    debug: getBoolean('debug'),
    dryRun: getBoolean('dry-run'),
    githubToken: core.getInput('github-token').trim(),
    labels: getOptionalInput('labels'),
    repository:
      core.getInput('repository') || github.context.repo.owner + '/' + github.context.repo.repo,
    setupMonochange: core.getInput('setup-monochange').trim() || 'true',
    skipLabels: getOptionalInput('skip-labels'),
  };
}

function getOptionalInput(name: string): string | undefined {
  const value = core.getInput(name).trim();

  return value || undefined;
}

function getBoolean(name: string): boolean {
  const value = core.getInput(name).trim().toLowerCase();

  return ['true', '1', 'yes', 'on'].includes(value);
}

export async function runChangesetPolicy(): Promise<void> {
  const inputs = readInputs();

  if (inputs.debug) {
    core.info(
      `changeset-policy inputs: ${JSON.stringify({ ...inputs, githubToken: '[redacted]' }, null, 2)}`,
    );
  }

  const mc = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${mc.version} from ${mc.source}`);

  const args = ['affected', '--format', 'json', '--verify'];

  if (inputs.changedPaths) {
    args.push('--paths', inputs.changedPaths);
  }

  if (inputs.labels) {
    args.push('--labels', inputs.labels);
  }

  if (inputs.skipLabels) {
    args.push('--skip-labels', inputs.skipLabels);
  }

  if (inputs.dryRun) {
    core.info(`Dry-run: would run \`${mc.command} ${args.join(' ')}\``);
    core.setOutput('result', 'dry-run');

    return;
  }

  const stdout = await execRequired(mc.command, args);
  const parsed = parseMixedOutput(stdout);

  core.setOutput('result', 'success');
  core.setOutput('json', JSON.stringify(parsed ?? null));
  core.setOutput('summary', stdout.slice(0, 65_536));

  core.info('changeset-policy completed successfully');
}
