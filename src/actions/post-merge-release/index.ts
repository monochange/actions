import * as core from '@actions/core';

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

export interface PostMergeReleaseInputs {
  setupMonochange: string;
  ref: string;
  targetBranch: string;
  dryRun: boolean;
  debug: boolean;
}

function readInputs(): PostMergeReleaseInputs {
  return {
    debug: getBoolean('debug'),
    dryRun: getBoolean('dry-run'),
    ref: core.getInput('ref').trim() || 'HEAD',
    setupMonochange: core.getInput('setup-monochange').trim() || 'true',
    targetBranch: core.getInput('target-branch').trim(),
  };
}

function getBoolean(name: string): boolean {
  const value = core.getInput(name).trim().toLowerCase();

  return ['true', '1', 'yes', 'on'].includes(value);
}

export async function runPostMergeRelease(): Promise<void> {
  const inputs = readInputs();

  if (inputs.debug) {
    core.info(`post-merge-release inputs: ${JSON.stringify(inputs, null, 2)}`);
  }

  const mc = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${mc.version} from ${mc.source}`);

  const recordArgs = ['release-record', '--from', inputs.ref, '--format', 'json'];

  if (inputs.targetBranch) {
    recordArgs.push('--branch', inputs.targetBranch);
  }

  if (inputs.dryRun) {
    core.info(`Dry-run: would run \`${mc.command} ${recordArgs.join(' ')}\``);
    core.info(`Dry-run: would run \`${mc.command} tag-release --from ${inputs.ref}\``);
    core.info(`Dry-run: would run \`${mc.command} publish-release\``);
    core.setOutput('result', 'dry-run');
    core.setOutput('tagged', 'false');
    core.setOutput('published', 'false');

    return;
  }

  // 1. Inspect release record
  const recordStdout = await execRequired(mc.command, recordArgs);
  const record = parseMixedOutput(recordStdout);

  if (!record) {
    core.info('No release record found for the given ref. Skipping.');
    core.setOutput('result', 'skipped');
    core.setOutput('tagged', 'false');
    core.setOutput('published', 'false');

    return;
  }

  // 2. Tag release
  const tagArgs = ['tag-release', '--from', inputs.ref];

  if (inputs.targetBranch) {
    tagArgs.push('--branch', inputs.targetBranch);
  }

  await execRequired(mc.command, tagArgs);

  core.setOutput('tagged', 'true');

  // 3. Publish release
  try {
    await execRequired(mc.command, ['publish-release']);
    core.setOutput('published', 'true');
  } catch (error) {
    core.warning(
      `publish-release failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    core.setOutput('published', 'false');
  }

  core.setOutput('result', 'success');
  core.setOutput('json', JSON.stringify(record));
  core.info('post-merge-release completed successfully');
}
