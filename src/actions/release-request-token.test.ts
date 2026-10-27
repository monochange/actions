import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveMonochange } from '../shared/monochange-cli';
import { runOpenReleaseRequest } from './open-release-request';
import { runReleasePr } from './release-pr';

vi.mock('../shared/monochange-cli', () => ({ resolveMonochange: vi.fn() }));

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'release-request-token-'));
  const command = join(directory, 'monochange.cjs');

  writeFileSync(
    command,
    `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.TOKEN_CAPTURE, JSON.stringify({
  token: process.env.GITHUB_TOKEN,
  inherited: process.env.RELEASE_REQUEST_INHERITED,
}));
process.stdout.write('{"number":42}');
process.exitCode = Number(process.env.CLI_STATUS);
`,
    { mode: 0o755 },
  );

  for (const file of ['environment', 'output']) {
    writeFileSync(join(directory, file), '');
  }

  vi.mocked(resolveMonochange).mockResolvedValue({
    command,
    source: 'existing-monochange',
    version: '1.0.0',
  });
  vi.stubEnv('INPUT_GITHUB-TOKEN', 'supplied-test-token');
  vi.stubEnv('INPUT_DRY-RUN', 'false');
  vi.stubEnv('INPUT_WORKING-DIRECTORY', directory);
  vi.stubEnv('GITHUB_ENV', join(directory, 'environment'));
  vi.stubEnv('GITHUB_OUTPUT', join(directory, 'output'));
  vi.stubEnv('GITHUB_TOKEN', 'original-test-token');
  vi.stubEnv('RELEASE_REQUEST_INHERITED', 'inherited-value');
  vi.stubEnv('RELEASE_REQUEST_UNDEFINED', undefined);
  vi.stubEnv('TOKEN_CAPTURE', join(directory, 'capture'));
  vi.stubEnv('CLI_STATUS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe.each([
  ['open-release-request', runOpenReleaseRequest],
  ['release-pr', runReleasePr],
] as const)('%s credential lifetime', (_name, run) => {
  it.each(['0', '1'])('scopes the token to the CLI when it exits with %s', async (status) => {
    vi.stubEnv('CLI_STATUS', status);

    await (status === '0' ? run() : expect(run()).rejects.toThrow());

    const captured: unknown = JSON.parse(readFileSync(join(directory, 'capture'), 'utf8'));
    expect(captured).toEqual({ token: 'supplied-test-token', inherited: 'inherited-value' });
    expect(readFileSync(join(directory, 'environment'), 'utf8')).toBe('');
    expect(process.env.GITHUB_TOKEN).toBe('original-test-token');

    const laterStep = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.GITHUB_TOKEN)'],
      {
        encoding: 'utf8',
      },
    );
    expect(laterStep.status, laterStep.stderr).toBe(0);
    expect(laterStep.stdout).toBe('original-test-token');
  });

  it('preserves ambient authentication when no token input is supplied', async () => {
    vi.stubEnv('INPUT_GITHUB-TOKEN', '');

    await run();

    const captured: unknown = JSON.parse(readFileSync(join(directory, 'capture'), 'utf8'));
    expect(captured).toEqual({ token: 'original-test-token', inherited: 'inherited-value' });
    expect(readFileSync(join(directory, 'environment'), 'utf8')).toBe('');
  });
});
