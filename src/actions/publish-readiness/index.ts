import * as core from '@actions/core';

import { exec, execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

function input(name: string, fallback = ''): string {
  return core.getInput(name).trim() || fallback;
}

function bool(name: string): boolean {
  return ['true', '1', 'yes', 'on'].includes(input(name).toLowerCase());
}

export async function runPublishReadiness(): Promise<void> {
  const monochange = await resolveMonochange(input('setup-monochange', 'true'));
  const cwd = input('working-directory', '.');
  const ref = input('ref', 'HEAD');
  const output = input('output', '.monochange/publish-readiness.json');
  const record = await exec(
    monochange.command,
    ['step', 'release-record', '--from', ref, '--format', 'json'],
    {
      cwd,
      ignoreReturnCode: true,
    },
  );

  if (record.exitCode !== 0) {
    const outputText = record.stdout.trim() || record.stderr.trim();
    const missing =
      /(?:no|not found|missing).*release record|release record.*(?:not found|missing)/i.test(
        outputText,
      );

    if (!missing) {
      throw new Error(outputText || `monochange step release-record failed for ${ref}.`);
    }

    core.info(`No monochange release record found at ${ref}; skipping publish readiness.`);
    core.setOutput('result', 'skipped');
    core.setOutput('has-release-record', 'false');
    core.setOutput('ready', 'false');
    return;
  }

  if (bool('dry-run')) {
    core.info(`Dry-run: would run publish-readiness for ${ref}`);
    core.setOutput('result', 'dry-run');
    core.setOutput('has-release-record', 'true');
    core.setOutput('ready', 'false');
    return;
  }

  const stdout = await execRequired(
    monochange.command,
    ['step', 'publish-readiness', '--from', ref, '--output', output, '--format', 'json'],
    { cwd },
  );
  const parsed = parseMixedOutput(stdout);
  core.setOutput('result', 'success');
  core.setOutput('has-release-record', 'true');
  core.setOutput('ready', 'true');
  core.setOutput('output-path', output);
  core.setOutput('json', JSON.stringify(parsed ?? null));
  core.setOutput('summary', stdout.slice(0, 65_536));
}
