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

  const exitCode = await actionsExec.exec(command, args, {
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
