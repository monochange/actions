import * as core from '@actions/core';

import { exec, execRequired } from './exec';
import { parseMixedOutput } from './json';

export type MonochangeSource = 'existing-mc' | 'npx-shim' | 'cargo-binstall' | 'custom-command';

export interface ResolvedMonochange {
  command: string;
  version: string;
  source: MonochangeSource;
}

export async function resolveMonochange(setupInput: string): Promise<ResolvedMonochange> {
  const lower = setupInput.trim().toLowerCase();

  if (lower === 'false') {
    const version = await getMcVersion('mc');

    if (!version) {
      throw new Error(
        'monochange is not available on PATH and setup-monochange is false. ' +
          'Install monochange manually or use setup-monochange: true.',
      );
    }

    return { command: 'mc', version, source: 'existing-mc' };
  }

  if (lower === 'true' || lower === '') {
    const existingVersion = await getMcVersion('mc');

    if (existingVersion) {
      return { command: 'mc', version: existingVersion, source: 'existing-mc' };
    }

    core.info('monochange not found on PATH; trying npx @monochange/cli');

    const npxVersion = await getMcVersion('npx', ['-y', '@monochange/cli']);

    if (npxVersion) {
      return {
        command: 'npx -y @monochange/cli',
        version: npxVersion,
        source: 'npx-shim',
      };
    }

    core.info('npx fallback failed; trying cargo binstall monochange');

    try {
      await execRequired('cargo', ['binstall', 'monochange', '-y']);
      const cargoVersion = await getMcVersion('mc');

      if (cargoVersion) {
        return { command: 'mc', version: cargoVersion, source: 'cargo-binstall' };
      }
    } catch {
      // fall through to error
    }

    throw new Error(
      'Could not resolve monochange automatically. ' +
        'Install monochange manually, use cargo binstall, or provide a custom command.',
    );
  }

  const version = await getMcVersion(setupInput);

  if (!version) {
    throw new Error(
      `setup-monochange command \`${setupInput}\` did not produce a valid mc --version output.`,
    );
  }

  return { command: setupInput, version, source: 'custom-command' };
}

async function getMcVersion(
  command: string,
  prefixArgs: string[] = [],
): Promise<string | undefined> {
  const args = [...prefixArgs, '--version'];

  if (command !== 'mc') {
    args.unshift(command);
  }

  const bin = args[0]!;
  const binArgs = args.slice(1);

  try {
    const result = await exec(bin, binArgs, {
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

  return parseMixedOutput<T>(stdout);
}
