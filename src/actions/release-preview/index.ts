import * as core from '@actions/core';

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

function input(name: string, fallback = ''): string {
  return core.getInput(name).trim() || fallback;
}

function bool(name: string, fallback = false): boolean {
  const value = input(name);
  return value ? ['true', '1', 'yes', 'on'].includes(value.toLowerCase()) : fallback;
}

export async function runReleasePreview(): Promise<void> {
  const monochange = await resolveMonochange(input('setup-monochange', 'true'));
  const cwd = input('working-directory', '.');
  const format = input('format', 'json');
  const args = ['step', 'prepare-release', '--dry-run', '--format', format];

  if (bool('diff', true)) {
    args.push('--diff');
  }

  const stdout = await execRequired(monochange.command, args, { cwd });
  const parsed = parseMixedOutput(stdout);
  core.setOutput('result', 'success');
  core.setOutput('json', JSON.stringify(parsed ?? null));
  core.setOutput('summary', stdout.slice(0, 65_536));
}
