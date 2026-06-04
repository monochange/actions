import * as actionsExec from '@actions/exec';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function exec(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: { [key: string]: string };
    ignoreReturnCode?: boolean;
    silent?: boolean;
  },
): Promise<ExecResult> {
  let stdout = '';
  let stderr = '';

  const [file, ...commandArgs] = splitCommand(command);
  const exitCode = await actionsExec.exec(file, [...commandArgs, ...args], {
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    ...(options?.env ? { env: options.env } : {}),
    ignoreReturnCode: options?.ignoreReturnCode ?? true,
    silent: options?.silent ?? true,
    listeners: {
      stdout(data) {
        stdout += data.toString();
      },
      stderr(data) {
        stderr += data.toString();
      },
    },
  });

  return { exitCode, stdout, stderr };
}

function splitCommand(command: string): [string, ...string[]] {
  const parts = command
    .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map((part) => part.replace(/^(["'])(.*)\1$/, '$2'));

  if (!parts) {
    return [command];
  }

  const [file = command, ...args] = parts;

  return [file, ...args];
}

export async function execRequired(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: { [key: string]: string };
    silent?: boolean;
  },
): Promise<string> {
  const result = await exec(command, args, {
    ...options,
    ignoreReturnCode: true,
  });

  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
    throw new Error(message);
  }

  return result.stdout.trim();
}
