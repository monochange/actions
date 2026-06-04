import * as core from '@actions/core';

import { execRequired } from '../../shared/exec';
import { resolveMonochange } from '../../shared/monochange-cli';

function input(name: string, fallback = ''): string {
  return core.getInput(name).trim() || fallback;
}

export async function runCheck(): Promise<void> {
  const monochange = await resolveMonochange(input('setup-monochange', 'true'));
  const cwd = input('working-directory', '.');
  const format = input('format');
  const args = ['check'];

  if (format) {
    args.push('--format', format);
  }

  const stdout = await execRequired(monochange.command, args, { cwd });
  core.setOutput('result', 'success');
  core.setOutput('summary', stdout.slice(0, 65_536));
}
