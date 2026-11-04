import { readFileSync } from 'node:fs';

import { parseAllDocuments } from 'yaml';

import packageJson from '../package.json' with { type: 'json' };
import type { MonochangeRelease } from '../src/shared/monochange-release';

/** Bind the runtime download to the same release and checksums used by the build. */
export function readMonochangeRelease(): MonochangeRelease {
  const version = packageJson.devDependencies['@monochange/cli'];
  const documents = parseAllDocuments(
    readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
  );
  // pnpm 12 writes a leading document with its own package-manager
  // dependencies and keeps the project lockfile in the final document, so
  // read the last one rather than assuming a single-document file.
  const lock = documents.at(-1);
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

  if (
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ||
    lock === undefined ||
    documents.some((document) => document.errors.length > 0)
  ) {
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
