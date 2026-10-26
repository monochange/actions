import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import packageJson from '../package.json' with { type: 'json' };

const sandbox = await mkdtemp(join(tmpdir(), 'monochange bootstrap '));
const output = join(sandbox, 'outputs');
const downloads = join(sandbox, 'downloads');
const tools = join(sandbox, 'trusted tools');
const systemRoot = process.env.SystemRoot;
const expectedVersion = `monochange ${packageJson.devDependencies['@monochange/cli']}`;

try {
  await mkdir(downloads);
  await mkdir(tools);

  // Force the download path even when the development machine already has monochange.
  if (process.platform === 'win32') {
    assert.ok(systemRoot);
    await copyFile(join(systemRoot, 'System32', 'tar.exe'), join(tools, 'tar.exe'));
  } else {
    await symlink('/usr/bin/tar', join(tools, 'tar'));
    await symlink('/usr/bin/gzip', join(tools, 'gzip'));
  }

  await writeFile(join(sandbox, '.npmrc'), '@monochange:registry=http://127.0.0.1:1\n');
  await writeFile(output, '');

  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../dist/index.mjs', import.meta.url))],
    {
      cwd: sandbox,
      env: {
        PATH: tools,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        ...(systemRoot ? { SystemRoot: systemRoot } : {}),
        INPUT_NAME: 'setup-monochange',
        'INPUT_SETUP-MONOCHANGE': 'true',
        GITHUB_OUTPUT: output,
        TMPDIR: downloads,
        TEMP: downloads,
        TMP: downloads,
      },
      encoding: 'utf8',
      timeout: 90_000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const outputs = await readFile(output, 'utf8');
  const command = outputs.match(/command<<[^\n]+\n([^\n]+)/)?.[1];
  assert.ok(command, outputs);
  const binary: unknown = JSON.parse(command);
  assert.ok(typeof binary === 'string');

  assert.ok(isAbsolute(binary));
  assert.ok(binary.startsWith(downloads));
  assert.match(outputs, /\npinned-download\r?\n/);
  assert.equal(
    execFileSync(binary, ['--version'], { cwd: sandbox, encoding: 'utf8' }).trim(),
    expectedVersion,
  );
  process.stdout.write(
    `Verified ${expectedVersion} from the published bundle with a hostile .npmrc.\n`,
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
