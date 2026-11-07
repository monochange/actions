import type { ExecResult } from '../../shared/exec';

export function pushValue(args: string[], flag: string, value: string): void {
  if (value !== '') {
    args.push(flag, value);
  }
}

export function failureDetail(result: ExecResult): string {
  const stderr = result.stderr.trim();

  if (stderr !== '') {
    return stderr;
  }

  const stdout = result.stdout.trim();

  return stdout === '' ? `exit code ${result.exitCode}` : stdout;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
