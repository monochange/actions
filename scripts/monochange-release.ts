import { readFileSync } from 'node:fs';

import { parseDocument } from 'yaml';

import packageJson from '../package.json' with { type: 'json' };
import type { MonochangeRelease } from '../src/shared/monochange-release';

/** Bind the runtime download to the same release and checksums used by the build. */
export function readMonochangeRelease(): MonochangeRelease {
  const version = packageJson.devDependencies['@monochange/cli'];
  const lock = parseDocument(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'));
  const targets = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64-gnu',
    'linux-arm64-musl',
    'linux-x64-gnu',
    'linux-x64-musl',
    'win32-arm64-msvc',
    'win32-x64-msvc',
  ];

  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || lock.errors.length > 0) {
    throw new Error('Automatic monochange setup requires an exact CLI version and valid lockfile.');
  }

  const integrities = Object.fromEntries(
    targets.map((target) => {
      const integrity: unknown = lock.getIn([
        'packages',
        `@monochange/cli-${target}@${version}`,
        'resolution',
        'integrity',
      ]);

      if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
        throw new Error(`Missing locked SHA-512 integrity for monochange ${version} (${target}).`);
      }

      return [target, integrity];
    }),
  );

  return { version, integrities };
}
