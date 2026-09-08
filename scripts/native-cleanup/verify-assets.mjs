import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { walkFiles } from '../walkFiles.mjs';

import { nativeCleanupTargets } from './targets.mjs';

/** Verify every target is included byte-for-byte, including inside archives. */
export async function verifyNativeCleanupAssets(files, read = readFile) {
  const failures = [];
  for (const target of nativeCleanupTargets) {
    const matches = files.filter((file) => basename(file) === `${target}.node`);
    if (matches.length !== 1) {
      failures.push(
        `Expected one packaged cleanup binary for ${target}, found ${matches.length}`,
      );
      continue;
    }
    const expected = await readFile(
      new URL(`./prebuilds/${target}.node`, import.meta.url),
    );
    const actual = await read(matches[0]);
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    if (hash(actual) !== hash(expected))
      failures.push(`Packaged cleanup binary differs from prebuild: ${target}`);
  }
  return failures;
}

/** electron-builder calls afterPack after copying/merging and before signing. */
export default async function verifyDesktopNativeAssets(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const directory = join(resources, 'app.asar.unpacked', 'dist', 'main');
  const failures = await verifyNativeCleanupAssets(
    walkFiles(directory).map((entry) => entry.absolutePath),
  );
  if (failures.length > 0) throw new Error(failures.join('\n'));
}
