import * as core from '@actions/core';

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

function input(name: string, fallback = ''): string {
  return core.getInput(name).trim() || fallback;
}

function bool(name: string): boolean {
  return ['true', '1', 'yes', 'on'].includes(input(name).toLowerCase());
}

export async function runPublishPackages(): Promise<void> {
  const monochange = await resolveMonochange(input('setup-monochange', 'true'));
  const cwd = input('working-directory', '.');
  const output = input('output', '.monochange/publish-result.json');
  const resume = input('resume');
  const args = ['step', 'publish-packages', '--output', output, '--format', 'json'];

  if (resume) {
    args.push('--resume', resume);
  }

  if (bool('all')) {
    args.push('--all');
  }

  if (bool('dry-run')) {
    core.info(`Dry-run: would run \`${monochange.command} ${args.join(' ')}\``);
    core.setOutput('result', 'dry-run');
    return;
  }

  const stdout = await execRequired(monochange.command, args, { cwd });
  const parsed = parseMixedOutput(stdout);
  core.setOutput('result', 'success');
  core.setOutput('output-path', output);
  core.setOutput('json', JSON.stringify(parsed ?? null));
  core.setOutput('summary', stdout.slice(0, 65_536));
}
