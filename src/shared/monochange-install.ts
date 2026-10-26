import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execRequired } from './exec';
import { monochangeRelease } from './monochange-release';

/** Download only a locked artifact, without consulting consumer package-manager configuration. */
export async function installMonochange(): Promise<string> {
  const target = getMonochangeTarget({
    platform: process.platform,
    arch: process.arch,
    report: process.report.getReport(),
  });
  const { version, integrities } = monochangeRelease;
  const integrity = integrities[target];

  if (!integrity) {
    throw new Error(
      `Automatic monochange setup is unsupported on ${target}. Provide a custom command.`,
    );
  }

  const response = await fetch(
    `https://registry.npmjs.org/@monochange/cli-${target}/-/cli-${target}-${version}.tgz`,
    { redirect: 'error', signal: AbortSignal.timeout(60_000) },
  );

  if (!response.ok) {
    throw new Error(`Could not download monochange ${version}: HTTP ${response.status}.`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const actualIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;

  // Security: verify the build's locked checksum before extracting or executing any downloaded bytes.
  if (actualIntegrity !== integrity) {
    throw new Error(`Integrity check failed for monochange ${version} (${target}).`);
  }

  const directory = await mkdtemp(join(tmpdir(), 'monochange-'));
  const archivePath = join(directory, 'cli.tgz');
  const binaryName = process.platform === 'win32' ? 'monochange.exe' : 'monochange';
  const binary = join(directory, 'package', 'bin', binaryName);

  try {
    await writeFile(archivePath, archive);
    await execRequired('tar', ['-xzf', archivePath, '-C', directory, `package/bin/${binaryName}`], {
      cwd: directory,
    });
    await chmod(binary, 0o755);
    await rm(archivePath);

    return binary;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Select the native package matching the runner, including Linux libc. */
export function getMonochangeTarget(options: {
  platform: NodeJS.Platform;
  arch: string;
  report: object;
}): string {
  const { platform, arch, report } = options;
  const base = `${platform}-${arch}`;

  if (platform === 'win32') {
    return `${base}-msvc`;
  }

  if (platform !== 'linux') {
    return base;
  }

  const glibc =
    'header' in report &&
    typeof report.header === 'object' &&
    report.header !== null &&
    'glibcVersionRuntime' in report.header &&
    typeof report.header.glibcVersionRuntime === 'string';

  return `${base}-${glibc ? 'gnu' : 'musl'}`;
}
