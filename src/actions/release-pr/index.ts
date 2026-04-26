import * as core from '@actions/core';

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

export interface ReleasePrInputs {
  setupMonochange: string;
  format: string;
  dryRun: boolean;
  githubToken: string;
  workingDirectory: string;
  debug: boolean;
}

function readInputs(): ReleasePrInputs {
  return {
    debug: getBoolean('debug'),
    dryRun: getBoolean('dry-run'),
    format: core.getInput('format').trim() || 'json',
    githubToken: core.getInput('github-token').trim(),
    setupMonochange: core.getInput('setup-monochange').trim() || 'true',
    workingDirectory: core.getInput('working-directory').trim() || '.',
  };
}

function getBoolean(name: string): boolean {
  const value = core.getInput(name).trim().toLowerCase();

  return ['true', '1', 'yes', 'on'].includes(value);
}

export async function runReleasePr(): Promise<void> {
  const inputs = readInputs();

  if (inputs.debug) {
    core.info(
      `release-pr inputs: ${JSON.stringify({ ...inputs, githubToken: '[redacted]' }, null, 2)}`,
    );
  }

  const mc = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${mc.version} from ${mc.source}`);

  if (inputs.dryRun) {
    core.info(`Dry-run: would run \`${mc.command} release-pr --format ${inputs.format}\``);
    core.setOutput('result', 'dry-run');
    core.setOutput('head-branch', '');
    core.setOutput('base-branch', '');
    core.setOutput('release-request-number', '');
    core.setOutput('release-request-url', '');
    core.setOutput('json', 'null');

    return;
  }

  const args = ['release-pr', '--format', inputs.format];

  if (inputs.githubToken) {
    core.exportVariable('GITHUB_TOKEN', inputs.githubToken);
  }

  const stdout = await execRequired(mc.command, args, { cwd: inputs.workingDirectory });
  const parsed = parseMixedOutput(stdout);
  const parsedRecord =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;

  core.setOutput('result', 'success');
  core.setOutput('json', JSON.stringify(parsedRecord ?? null));
  core.setOutput('head-branch', parsedRecord?.headBranch ?? '');
  core.setOutput('base-branch', parsedRecord?.baseBranch ?? '');
  core.setOutput(
    'release-request-number',
    typeof parsedRecord?.number === 'number' || typeof parsedRecord?.number === 'string'
      ? String(parsedRecord.number)
      : '',
  );
  core.setOutput('release-request-url', parsedRecord?.url ?? '');

  core.info('release-pr completed successfully');
}
