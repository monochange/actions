import * as core from '@actions/core';

import { exec } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

function input(name: string, fallback = ''): string {
  return core.getInput(name).trim() || fallback;
}

function bool(name: string): boolean {
  return ['true', '1', 'yes', 'on'].includes(input(name).toLowerCase());
}

export async function runReleaseRecord(): Promise<void> {
  const monochange = await resolveMonochange(input('setup-monochange', 'true'));
  const ref = input('ref', 'HEAD');
  const cwd = input('working-directory', '.');
  const failIfMissing = bool('fail-if-missing');
  const args = ['step', 'release-record', '--from', ref, '--format', 'json'];

  if (bool('dry-run')) {
    core.info(`Dry-run: would run \`${monochange.command} ${args.join(' ')}\``);
    core.setOutput('result', 'dry-run');
    core.setOutput('has-release-record', 'false');
    core.setOutput('json', 'null');
    return;
  }

  const result = await exec(monochange.command, args, { cwd, ignoreReturnCode: true });
  const output = result.stdout.trim() || result.stderr.trim();

  if (result.exitCode !== 0) {
    const missing =
      /(?:no|not found|missing).*release record|release record.*(?:not found|missing)/i.test(
        output,
      );

    if (!missing) {
      throw new Error(output || `monochange step release-record failed for ${ref}.`);
    }

    if (failIfMissing) {
      throw new Error(output);
    }

    core.info(output);
    core.setOutput('result', 'skipped');
    core.setOutput('has-release-record', 'false');
    core.setOutput('json', 'null');
    core.setOutput('summary', `No monochange release record found at ${ref}.`);
    return;
  }

  const parsed = parseMixedOutput(output);
  const json = JSON.stringify(parsed ?? null);
  core.setOutput('result', 'success');
  core.setOutput('has-release-record', parsed ? 'true' : 'false');
  core.setOutput('json', json);
  core.setOutput(
    'summary',
    parsed
      ? `Found monochange release record at ${ref}.`
      : `No monochange release record found at ${ref}.`,
  );
}
