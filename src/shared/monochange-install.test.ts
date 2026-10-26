import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMcCommand } from './monochange-cli';
import { getMonochangeTarget, installMonochange } from './monochange-install';

const release = vi.hoisted(() => {
  const integrities: Record<string, string> = {};

  return { version: '0.21.0', integrities };
});

vi.mock('./monochange-release', () => ({ monochangeRelease: release }));

let sandbox: string;
let archive: Buffer;
let target: string;
const fetchMock = vi.fn<typeof fetch>();

describe('installMonochange', () => {
  beforeEach(async () => {
    sandbox = await mkdtemp(join(os.tmpdir(), 'monochange test '));
    await mkdir(join(sandbox, 'package', 'bin'), { recursive: true });
    await writeFile(join(sandbox, '.npmrc'), '@monochange:registry=http://127.0.0.1:1\n');
    await writeFile(
      join(sandbox, 'package', 'bin', 'monochange'),
      '#!/usr/bin/env node\nprocess.stdout.write("monochange 0.21.0\\n");\n',
    );
    await writeFile(join(sandbox, 'package', 'bin', 'monochange.exe'), 'windows fixture');
    execFileSync('tar', ['-czf', join(sandbox, 'cli.tgz'), '-C', sandbox, 'package']);
    archive = await readFile(join(sandbox, 'cli.tgz'));
    target = getMonochangeTarget({
      platform: process.platform,
      arch: process.arch,
      report: process.report.getReport(),
    });
    release.integrities[target] = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    vi.stubEnv('TMPDIR', sandbox);
    vi.stubEnv('TEMP', sandbox);
    vi.stubEnv('TMP', sandbox);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('extracts the locked binary into a private absolute path without reading .npmrc', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(archive)));

    const binary = await installMonochange();

    expect(isAbsolute(binary)).toBe(true);
    expect(binary.startsWith(join(sandbox, 'monochange-'))).toBe(true);
    expect(await readFile(binary)).toEqual(
      await readFile(
        join(
          sandbox,
          'package',
          'bin',
          process.platform === 'win32' ? 'monochange.exe' : 'monochange',
        ),
      ),
    );
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://registry.npmjs.org/@monochange/cli-${target}/-/cli-${target}-0.21.0.tgz`,
      { redirect: 'error', signal: expect.any(AbortSignal) },
    );
    expect(await readdir(join(binary, '..', '..', '..'))).not.toContain('cli.tgz');
  });

  it.skipIf(process.platform === 'win32')(
    'executes the extracted path with spaces from the consumer directory without resolving again',
    async () => {
      fetchMock.mockResolvedValue(new Response(new Uint8Array(archive)));
      const binary = await installMonochange();

      const output = await runMcCommand({
        command: `"${binary}"`,
        args: ['--version'],
        cwd: sandbox,
      });

      expect(output).toBe('monochange 0.21.0');
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('rejects modified bytes before creating an installation directory', async () => {
    fetchMock.mockResolvedValue(new Response('untrusted archive'));
    const before = await readdir(sandbox);

    await expect(installMonochange()).rejects.toThrow('Integrity check failed');

    expect(await readdir(sandbox)).toEqual(before);
  });

  it('fails closed on download errors', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));

    await expect(installMonochange()).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('propagates network failures without falling back', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));

    await expect(installMonochange()).rejects.toThrow('network unavailable');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('removes the private directory if extraction fails', async () => {
    const bytes = Buffer.from('invalid tar archive');
    release.integrities[target] = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    fetchMock.mockResolvedValue(new Response(bytes));
    const before = await readdir(sandbox);

    await expect(installMonochange()).rejects.toThrow();

    expect(await readdir(sandbox)).toEqual(before);
  });

  it('rejects platforms without a locked package before downloading', async () => {
    delete release.integrities[target];

    await expect(installMonochange()).rejects.toThrow('unsupported');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts the Windows executable from the locked Windows package', async () => {
    vi.stubGlobal(
      'process',
      Object.create(process, {
        platform: { value: 'win32' },
        arch: { value: 'x64' },
      }),
    );
    release.integrities['win32-x64-msvc'] = release.integrities[target] ?? '';
    fetchMock.mockResolvedValue(new Response(new Uint8Array(archive)));

    const binary = await installMonochange();

    expect(binary.endsWith('monochange.exe')).toBe(true);
    expect(await readFile(binary, 'utf8')).toBe('windows fixture');
  });
});

describe('getMonochangeTarget', () => {
  it.each(['arm64', 'x64'])('selects the Darwin and Windows packages for %s', (arch) => {
    expect(getMonochangeTarget({ platform: 'darwin', arch, report: {} })).toBe(`darwin-${arch}`);
    expect(getMonochangeTarget({ platform: 'win32', arch, report: {} })).toBe(`win32-${arch}-msvc`);
  });

  it.each(['arm64', 'x64'])('selects Linux glibc for %s', (arch) => {
    expect(
      getMonochangeTarget({
        platform: 'linux',
        arch,
        report: { header: { glibcVersionRuntime: '2.40' } },
      }),
    ).toBe(`linux-${arch}-gnu`);
  });

  it.each([
    {},
    { header: null },
    { header: 'invalid' },
    { header: {} },
    { header: { glibcVersionRuntime: 2 } },
  ])('selects Linux musl when glibc is absent: %j', (report) => {
    expect(getMonochangeTarget({ platform: 'linux', arch: 'x64', report })).toBe('linux-x64-musl');
  });
});
