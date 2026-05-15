import { readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
  } else {
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

  await pruneClaudeAgentSdkPackages(resourcesDir, expectedPlatformKeys);
}

async function pruneClaudeAgentSdkPackages(resourcesDir, expectedPlatformKeys) {
  const unpackedRoot = join(resourcesDir, 'app.asar.unpacked');
  const expected = new Set(
    expectedPlatformKeys.flatMap((key) =>
      key.startsWith('linux-') ? [key, `${key}-musl`] : [key],
    ),
  );
  const removed = [];

  for (const root of [
    join(unpackedRoot, 'node_modules', '@anthropic-ai'),
    join(unpackedRoot, 'node_modules', '.pnpm'),
  ]) {
    const entries = await safeReaddir(root);
    for (const entry of entries) {
      const matched = matchClaudeAgentSdkEntry(entry);
      if (matched == null) continue;
      if (expected.has(matched)) continue;

      const target = join(root, entry);
      await rm(target, { recursive: true, force: true });
      removed.push(relative(unpackedRoot, target));
    }
  }

  if (removed.length === 0) {
    console.log(
      `claude-agent-sdk payload pruning kept expected packages: ${[...expected].join(', ')}`,
    );
    return;
  }

  console.log(
    `claude-agent-sdk payload pruning removed unused packages: ${removed.join(', ')}`,
  );
}

const claudeAgentSdkPlatformKeys = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-musl',
  'linux-x64-musl',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
];

function matchClaudeAgentSdkEntry(entry) {
  for (const platformKey of claudeAgentSdkPlatformKeys) {
    const directName = `claude-agent-sdk-${platformKey}`;
    if (entry === directName) return platformKey;
    if (entry.includes(`@anthropic-ai+claude-agent-sdk-${platformKey}@`)) {
      return platformKey;
    }
  }
  return null;
}

async function safeReaddir(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error(
    'prune-desktop-codex-payload.mjs is an electron-builder afterPack hook and must be loaded by electron-builder.',
  );
  process.exit(1);
}
