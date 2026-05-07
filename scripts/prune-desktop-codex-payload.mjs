import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  describeBundledCodexPackages,
  inferCodexPlatformKeys,
  pruneBundledCodexPackages,
  resourcesDirForElectronBuilderContext,
} from './desktop-codex-payload.mjs';

export default async function pruneDesktopCodexPayload(context) {
  const expectedPlatformKeys = inferCodexPlatformKeys({
    platform: context.electronPlatformName,
    arch: context.arch,
    appPath: context.appOutDir,
  });

  if (expectedPlatformKeys.length === 0) {
    throw new Error(
      `Could not infer expected Codex CLI platform packages for ${context.electronPlatformName}/${context.arch} at ${context.appOutDir}`,
    );
  }

  const resourcesDir = resourcesDirForElectronBuilderContext(context);
  const pruned = await pruneBundledCodexPackages(
    resourcesDir,
    expectedPlatformKeys,
  );

  if (pruned.length === 0) {
    console.log(
      `Codex CLI payload pruning kept expected packages: ${expectedPlatformKeys.join(
        ', ',
      )}`,
    );
    return;
  }

  console.log(
    `Codex CLI payload pruning removed unused packages: ${describeBundledCodexPackages(
      pruned.map(({ platformKey, pkg, path }) => ({
        platformKey,
        pkg,
        locations: [path],
        sizeBytes: 0,
      })),
    )}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error(
    'prune-desktop-codex-payload.mjs is an electron-builder afterPack hook and must be loaded by electron-builder.',
  );
  process.exit(1);
}
