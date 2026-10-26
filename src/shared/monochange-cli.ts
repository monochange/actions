import * as core from '@actions/core';

import { exec, execRequired } from './exec';
import { parseMixedOutput } from './json';
import { installMonochange } from './monochange-install';
import { monochangeRelease } from './monochange-release';

export type MonochangeSource = 'existing-monochange' | 'pinned-download' | 'custom-command';

export interface ResolvedMonochange {
  command: string;
  version: string;
  source: MonochangeSource;
}

export async function resolveMonochange(setupInput: string): Promise<ResolvedMonochange> {
  const lower = setupInput.trim().toLowerCase();

  if (lower === 'false') {
    const version = await getMonochangeVersion('monochange');

    if (!version) {
      throw new Error(
        'monochange is not available on PATH and setup-monochange is false. ' +
          'Install monochange manually or use setup-monochange: true.',
      );
    }

    return { command: 'monochange', version, source: 'existing-monochange' };
  }

  if (lower === 'true' || lower === '') {
    const existingVersion = await getMonochangeVersion('monochange');

    if (existingVersion) {
      return { command: 'monochange', version: existingVersion, source: 'existing-monochange' };
    }

    core.info(
      `monochange not found on PATH; downloading locked monochange ${monochangeRelease.version}`,
    );

    const binary = await installMonochange();
    const command = JSON.stringify(binary);
    const version = await getMonochangeVersion(command);

    if (version !== `monochange ${monochangeRelease.version}`) {
      throw new Error(
        `Downloaded monochange did not report the expected version ${monochangeRelease.version}.`,
      );
    }

    return { command, version, source: 'pinned-download' };
  }

  const version = await getMonochangeVersion(setupInput);

  if (!version) {
    throw new Error(
      `setup-monochange command \`${setupInput}\` did not produce a valid monochange --version output.`,
    );
  }

  return { command: setupInput, version, source: 'custom-command' };
}

async function getMonochangeVersion(command: string): Promise<string | undefined> {
  try {
    const result = await exec(command, ['--version'], {
      ignoreReturnCode: true,
      silent: true,
    });

    if (result.exitCode === 0) {
      const versionText = result.stdout.trim();

      if (versionText) {
        return versionText;
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}

export async function runMcCommand(options: {
  command: string;
  args: string[];
  cwd?: string;
}): Promise<string> {
  const { command, args, cwd } = options;
  core.info(`Running: ${command} ${args.join(' ')}`);

  return execRequired(command, args, cwd ? { cwd } : undefined);
}

export async function runMcJsonCommand<T>(options: {
  command: string;
  args: string[];
  cwd?: string;
}): Promise<T | undefined> {
  const stdout = await runMcCommand(options);

  return parseMixedOutput(stdout) as T | undefined;
}
