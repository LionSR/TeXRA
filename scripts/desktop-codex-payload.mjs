import { access, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const MEBIBYTE = 1024 * 1024;

const CODEX_PAYLOAD_HEADROOM_BYTES_PER_PLATFORM = 16 * MEBIBYTE;
// npm dist.unpackedSize values audited for @openai/codex 0.144.1.
export const codexPayloadBaselineBytesByPlatform = {
  'darwin-arm64': 311_569_963,
  'darwin-x64': 337_129_194,
  'linux-arm64': 308_463_407,
  'linux-x64': 351_529_018,
  'win32-arm64': 356_454_041,
  'win32-x64': 409_157_780,
};

export const codexPlatformInfoByKey = {
  'linux-x64': {
    pkg: '@openai/codex-linux-x64',
    triple: 'x86_64-unknown-linux-musl',
    binaryName: 'codex',
  },
  'linux-arm64': {
    pkg: '@openai/codex-linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
    binaryName: 'codex',
  },
  'darwin-x64': {
    pkg: '@openai/codex-darwin-x64',
    triple: 'x86_64-apple-darwin',
    binaryName: 'codex',
  },
  'darwin-arm64': {
    pkg: '@openai/codex-darwin-arm64',
    triple: 'aarch64-apple-darwin',
    binaryName: 'codex',
  },
  'win32-x64': {
    pkg: '@openai/codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    binaryName: 'codex.exe',
  },
  'win32-arm64': {
    pkg: '@openai/codex-win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
    binaryName: 'codex.exe',
  },
};

const archNameByElectronBuilderArch = {
  1: 'x64',
  3: 'arm64',
  4: 'universal',
};

const platformKeyByPackageName = new Map(
  Object.entries(codexPlatformInfoByKey).map(([platformKey, info]) => [
    info.pkg,
    platformKey,
  ]),
);

export function codexBinaryPath(prefix, platformInfo) {
  return codexBinaryPathCandidates(prefix, platformInfo)[0];
}

export function codexBinaryPathCandidates(prefix, platformInfo) {
  return codexBinarySubpathCandidates(platformInfo).map((subpath) =>
    join(prefix, 'node_modules', ...platformInfo.pkg.split('/'), subpath)
      .replaceAll('\\', '/')
      .replace(/^\//, ''),
  );
}

export function codexBinarySubpathCandidates(platformInfo) {
  return [
    join('vendor', platformInfo.triple, 'codex', platformInfo.binaryName),
    join('vendor', platformInfo.triple, 'bin', platformInfo.binaryName),
  ].map((path) => path.replaceAll('\\', '/'));
}

export function formatBytes(bytes) {
  return `${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}

export function expectedCodexPayloadBudgetBytes(expectedPlatformKeys) {
  let budgetBytes = 0;
  for (const platformKey of expectedPlatformKeys) {
    const baselineBytes = codexPayloadBaselineBytesByPlatform[platformKey];
    if (baselineBytes == null) {
      throw new Error(
        `Codex payload budget has no audited baseline for ${platformKey}.`,
      );
    }
    budgetBytes += baselineBytes + CODEX_PAYLOAD_HEADROOM_BYTES_PER_PLATFORM;
  }
  return budgetBytes;
}

export function inferCodexPlatformKeys({ platform, arch, appPath } = {}) {
  const normalizedPath = (appPath ?? '').replaceAll('\\', '/').toLowerCase();
  const normalizedPlatform = normalizePlatform(platform, normalizedPath);
  const normalizedArch = normalizeArch(
    arch,
    normalizedPath,
    normalizedPlatform,
  );

  if (normalizedPlatform == null || normalizedArch == null) return [];

  if (normalizedPlatform === 'darwin' && normalizedArch === 'universal') {
    return ['darwin-x64', 'darwin-arm64'];
  }
  if (normalizedArch !== 'x64' && normalizedArch !== 'arm64') return [];

  return [`${normalizedPlatform}-${normalizedArch}`];
}

export function packageNameForCodexPlatformKey(platformKey) {
  return codexPlatformInfoByKey[platformKey]?.pkg ?? platformKey;
}

export function describeBundledCodexPackages(packages) {
  if (packages.length === 0) return 'none';
  return packages
    .map(({ platformKey, pkg, locations, sizeBytes }) => {
      const locationSummary =
        locations.length > 0 ? ` at ${locations.join(', ')}` : '';
      const sizeSummary = sizeBytes > 0 ? ` (${formatBytes(sizeBytes)})` : '';
      return `${pkg} [${platformKey}]${sizeSummary}${locationSummary}`;
    })
    .join('; ');
}

export async function collectBundledCodexPackages(resourcesDir) {
  const unpackedRoot = join(resourcesDir, 'app.asar.unpacked');
  const candidates = await collectCodexPackageCandidates(unpackedRoot);
  const byPlatformKey = new Map();
  const sizedRealPaths = new Set();

  for (const candidate of candidates) {
    const existingPath = await existingCandidatePath(candidate.path);
    if (existingPath == null) continue;

    const current = byPlatformKey.get(candidate.platformKey) ?? {
      platformKey: candidate.platformKey,
      pkg: packageNameForCodexPlatformKey(candidate.platformKey),
      locations: [],
      sizeBytes: 0,
    };
    current.locations.push(relative(unpackedRoot, candidate.path));
    const candidateRealPath = await realpath(existingPath);
    if (!sizedRealPaths.has(candidateRealPath)) {
      current.sizeBytes += await directorySize(existingPath);
      sizedRealPaths.add(candidateRealPath);
    }
    byPlatformKey.set(candidate.platformKey, current);
  }

  return [...byPlatformKey.values()].sort((left, right) =>
    left.platformKey.localeCompare(right.platformKey),
  );
}

export async function pruneBundledCodexPackages(resourcesDir, expectedKeys) {
  const expected = new Set(expectedKeys);
  const unpackedRoot = join(resourcesDir, 'app.asar.unpacked');
  const candidates = await collectCodexPackageCandidates(unpackedRoot);
  const pruned = [];

  for (const candidate of candidates) {
    if (expected.has(candidate.platformKey)) continue;
    if (!(await exists(candidate.path))) continue;

    await rm(candidate.path, { recursive: true, force: true });
    pruned.push({
      platformKey: candidate.platformKey,
      pkg: packageNameForCodexPlatformKey(candidate.platformKey),
      path: relative(unpackedRoot, candidate.path),
    });
  }

  return pruned.sort((left, right) => left.path.localeCompare(right.path));
}

export function resourcesDirForElectronBuilderContext(context) {
  if (typeof context.packager?.getResourcesDir === 'function') {
    return context.packager.getResourcesDir(context.appOutDir);
  }

  if (context.electronPlatformName === 'darwin') {
    const productName =
      context.packager?.appInfo?.productFilename ??
      context.packager?.appInfo?.productName ??
      'TeXRA';
    return join(
      context.appOutDir,
      `${productName}.app`,
      'Contents',
      'Resources',
    );
  }

  if (
    context.electronPlatformName === 'linux' ||
    context.electronPlatformName === 'win32'
  ) {
    return join(context.appOutDir, 'resources');
  }

  return context.appOutDir;
}

async function collectCodexPackageCandidates(unpackedRoot) {
  return [
    ...(await collectOpenAiAliasCandidates(unpackedRoot)),
    ...(await collectPnpmStoreCandidates(unpackedRoot)),
  ];
}

async function collectOpenAiAliasCandidates(unpackedRoot) {
  const openAiDir = join(unpackedRoot, 'node_modules', '@openai');
  const entries = await readDirNames(openAiDir);
  return entries
    .map((entry) => {
      const pkg = `@openai/${entry}`;
      const platformKey = platformKeyByPackageName.get(pkg);
      if (platformKey == null) return null;
      return { platformKey, path: join(openAiDir, entry) };
    })
    .filter((candidate) => candidate != null);
}

async function collectPnpmStoreCandidates(unpackedRoot) {
  const pnpmDir = join(unpackedRoot, 'node_modules', '.pnpm');
  const entries = await readDirNames(pnpmDir);
  const candidates = [];

  for (const entry of entries) {
    const platformKey = inferPlatformKeyFromPnpmEntry(entry);
    if (platformKey == null) continue;

    for (const packageRoot of pnpmCodexPackageRootCandidates(
      pnpmDir,
      entry,
      platformKey,
    )) {
      if (await exists(packageRoot)) {
        candidates.push({ platformKey, path: packageRoot });
        break;
      }
    }
  }

  return candidates;
}

function pnpmCodexPackageRootCandidates(pnpmDir, entry, platformKey) {
  const entryRoot = join(pnpmDir, entry);
  const platformInfo = codexPlatformInfoByKey[platformKey];
  return [
    join(entryRoot, 'node_modules', ...platformInfo.pkg.split('/')),
    join(entryRoot, 'node_modules', '@openai', 'codex'),
  ];
}

function inferPlatformKeyFromPnpmEntry(entry) {
  for (const platformKey of Object.keys(codexPlatformInfoByKey)) {
    if (entry.includes(`-${platformKey}`)) return platformKey;
  }
  return null;
}

async function directorySize(path) {
  const entryStat = await stat(path);
  if (!entryStat.isDirectory()) return entryStat.size;

  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    total += await directorySize(join(path, entry.name));
  }
  return total;
}

async function existingCandidatePath(path) {
  try {
    await stat(path);
    return path;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readDirNames(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function normalizePlatform(platform, normalizedPath) {
  if (platform === 'darwin' || platform === 'mac') return 'darwin';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32' || platform === 'win') return 'win32';

  if (normalizedPath.includes('.app/contents/resources')) return 'darwin';
  if (hasPathToken(normalizedPath, 'mac', 'darwin')) {
    return 'darwin';
  }
  if (hasPathToken(normalizedPath, 'linux')) return 'linux';
  if (hasPathToken(normalizedPath, 'win', 'win32', 'windows')) return 'win32';

  return null;
}

function hasPathToken(normalizedPath, ...tokens) {
  return normalizedPath
    .split('/')
    .some((segment) => hasSegmentToken(segment, ...tokens));
}

function hasSegmentToken(segment, ...tokens) {
  return tokens.some((token) =>
    new RegExp(`(^|[-_])${token}($|[-_])`).test(segment),
  );
}

function archFromPathToken(normalizedPath) {
  const segments = normalizedPath.split('/').reverse();
  for (const segment of segments) {
    if (isUniversalDarwinSegment(segment)) return 'universal';
    if (hasSegmentToken(segment, 'arm64', 'aarch64')) return 'arm64';
    if (hasSegmentToken(segment, 'x64', 'x86_64', 'amd64')) return 'x64';
  }
  return null;
}

function isUniversalDarwinSegment(segment) {
  return (
    (segment === 'universal' || hasSegmentToken(segment, 'mac', 'darwin')) &&
    hasSegmentToken(segment, 'universal')
  );
}

function normalizeArch(arch, normalizedPath, normalizedPlatform) {
  const pathArch = archFromPathToken(normalizedPath);
  if (normalizedPlatform === 'darwin' && pathArch === 'universal') {
    return 'universal';
  }

  const archName = archNameByElectronBuilderArch[arch] ?? arch;
  if (archName === 'universal') return 'universal';
  if (archName === 'arm64') return 'arm64';
  if (archName === 'x64') return 'x64';

  if (pathArch != null) return pathArch;

  if (
    normalizedPlatform != null &&
    normalizedPlatform === normalizePlatform(process.platform, '')
  ) {
    return process.arch === 'arm64' ? 'arm64' : 'x64';
  }

  if (normalizedPlatform === 'linux' || normalizedPlatform === 'win32') {
    return 'x64';
  }

  return null;
}
