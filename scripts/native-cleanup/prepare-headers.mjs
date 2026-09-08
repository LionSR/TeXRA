// Build-time dependency acquisition only. Published artifacts contain every binary.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const version = 'v22.13.0';
const base = `https://nodejs.org/download/release/${version}/`;
const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
async function download(name, source = base) {
  const response = await fetch(new URL(name, source));
  if (!response.ok)
    throw new Error(`Node header download failed: ${response.status} ${name}`);
  return Buffer.from(await response.arrayBuffer());
}
const checksums = (await download('SHASUMS256.txt')).toString('utf8');
for (const name of [
  `node-${version}-headers.tar.gz`,
  ...(process.platform === 'win32' ? [`win-${process.argv[3]}/node.lib`] : []),
]) {
  const bytes = await download(name);
  const expected = checksums
    .split('\n')
    .find((line) => line.endsWith(`  ${name}`))
    ?.split(' ')[0];
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`Node build dependency checksum mismatch: ${name}`);
  }
  const file = resolve(
    destination,
    name.endsWith('.lib') ? 'node.lib' : 'headers.tar.gz',
  );
  await writeFile(file, bytes);
  if (name.endsWith('.gz')) {
    const result = spawnSync('tar', ['-xzf', file, '-C', destination], {
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

// Use the host engine through its public extension API, without linking SQLite.
const sqliteHeaders = {
  'sqlite3.h':
    'b4b4cbcc2bd6dda8eaf348103c330c971676a59b3732cca068098f574de43994',
  'sqlite3ext.h':
    'b184dd1586d935133d37ad76fa353faf0a1021ff2fdedeedcc3498fff74bbb94',
};
for (const [name, expected] of Object.entries(sqliteHeaders)) {
  const bytes = await download(
    name,
    `https://raw.githubusercontent.com/nodejs/node/${version}/deps/sqlite/`,
  );
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`SQLite extension header checksum mismatch: ${name}`);
  }
  await writeFile(
    resolve(destination, `node-${version}`, 'include/node', name),
    bytes,
  );
}
