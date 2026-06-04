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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outputValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

export async function runOpenReleaseRequest(): Promise<void> {
  const monochange = await resolveMonochange(input('setup-monochange', 'true'));
  const cwd = input('working-directory', '.');
  const format = input('format', 'json');
  const args = ['step', 'open-release-request', '--format', format];

  if (bool('dry-run')) {
    core.info(`Dry-run: would run \`${monochange.command} ${args.join(' ')}\``);
    core.setOutput('result', 'dry-run');
    return;
  }

  const token = input('github-token');
  if (token) {
    core.exportVariable('GITHUB_TOKEN', token);
  }

  const stdout = await execRequired(monochange.command, args, { cwd });
  const mixed = parseMixedOutput(stdout);
  const parsed = isRecord(mixed) ? mixed : undefined;
  core.setOutput('result', 'success');
  core.setOutput('json', JSON.stringify(parsed ?? null));
  core.setOutput('head-branch', outputValue(parsed?.headBranch));
  core.setOutput('base-branch', outputValue(parsed?.baseBranch));
  core.setOutput('release-request-number', outputValue(parsed?.number));
  core.setOutput('release-request-url', outputValue(parsed?.url));
}
