import { access, readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, posix, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  getDesktopSharedSourceDirs,
  getDesktopVscodeFreeSourceDirs,
  vscodeBackedStateImportPattern,
  vscodeRuntimeImportPattern,
} from './extension-package-utils.mjs';

const require = createRequire(import.meta.url);
const { extractFile, listPackage, statFile } = require('@electron/asar');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = join(repoRoot, 'packages', 'desktop');
const packageRoot = join(desktopRoot, 'dist-packaged');
const desktopPackageJsonPath = join(desktopRoot, 'package.json');
const desktopIconPath = join(desktopRoot, 'build', 'icon.icns');
const desktopSharedSourceDirs = getDesktopSharedSourceDirs(repoRoot);
const desktopVscodeFreeSourceDirs = getDesktopVscodeFreeSourceDirs(repoRoot);
const desktopSharedSourceDirSet = new Set(desktopSharedSourceDirs);
const desktopVscodeFreeSourceDirSet = new Set(desktopVscodeFreeSourceDirs);
const desktopSourceBoundaryDirs = [
  ...new Set([...desktopSharedSourceDirs, ...desktopVscodeFreeSourceDirs]),
];
const bundledAgentResourceDirs = ['agents', 'tool_use_agents'];
const codexPlatformInfoByKey = {
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
const desktopStartupForbiddenBundleMarkers = [
  {
    label: '@google/genai',
    patterns: [
      '@google/genai',
      'node_modules/.pnpm/@google+genai',
      'google-auth-library',
    ],
  },
  {
    label: 'OpenAI SDK',
    patterns: ['node_modules/.pnpm/openai@'],
  },
  {
    label: 'Anthropic SDK',
    patterns: ['node_modules/.pnpm/@anthropic-ai'],
  },
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function findPackagedApp() {
  const pending = [{ path: packageRoot, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 8) continue;

    const asarPath = join(current.path, 'app.asar');
    if (await exists(asarPath)) {
      return createAsarAppReader(asarPath);
    }

    const packageJsonPath = join(current.path, 'package.json');
    if (
      (await exists(packageJsonPath)) &&
      (await exists(join(current.path, 'dist', 'main', 'index.js')))
    ) {
      return createDirectoryAppReader(current.path);
    }

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      pending.push({
        path: join(current.path, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return null;
}

function normalizeAsarPath(path) {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function createAsarAppReader(asarPath) {
  const entryPathByNormalizedPath = new Map(
    listPackage(asarPath).map((entry) => [normalizeAsarPath(entry), entry]),
  );
  const entries = new Set(entryPathByNormalizedPath.keys());
  const resourceRoot = dirname(asarPath);
  function stripLeadingArchiveSeparator(path) {
    return path.replace(/^[/\\]+/, '');
  }
  function asarEntryPathCandidates(path) {
    const mappedPath = entryPathByNormalizedPath.get(normalizeAsarPath(path));
    return [
      mappedPath,
      mappedPath == null ? null : stripLeadingArchiveSeparator(mappedPath),
      mappedPath == null
        ? null
        : stripLeadingArchiveSeparator(mappedPath).replaceAll('\\', '/'),
      stripLeadingArchiveSeparator(path),
      stripLeadingArchiveSeparator(path).replaceAll('\\', '/'),
      path,
    ].filter((candidate, index, candidates) => {
      return candidate != null && candidates.indexOf(candidate) === index;
    });
  }
  function readAsarFile(path) {
    let lastError = null;
    for (const candidate of asarEntryPathCandidates(path)) {
      try {
        return extractFile(asarPath, candidate);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  function isAsarEntryUnpacked(path) {
    for (const candidate of asarEntryPathCandidates(path)) {
      try {
        return statFile(asarPath, candidate).unpacked === true;
      } catch {
        // Try the next normalized candidate.
      }
    }
    return false;
  }
  return {
    isAsar: true,
    label: relative(repoRoot, asarPath),
    async exists(path) {
      if (entries.has(normalizeAsarPath(path))) return true;
      return exists(join(resourceRoot, path));
    },
    async isDirectory(path) {
      const normalizedPath = normalizeAsarPath(path);
      for (const entry of entries) {
        if (entry.startsWith(`${normalizedPath}/`)) return true;
      }
      try {
        return (await stat(join(resourceRoot, path))).isDirectory();
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
    async readJson(path) {
      return JSON.parse(readAsarFile(path).toString('utf8'));
    },
    async readText(path) {
      return readAsarFile(path).toString('utf8');
    },
    async readBuffer(path) {
      if (entries.has(normalizeAsarPath(path))) {
        return readAsarFile(path);
      }
      return readFile(join(resourceRoot, path));
    },
    async isUnpacked(path) {
      return isAsarEntryUnpacked(path);
    },
    async listDir(path) {
      const prefix = `${normalizeAsarPath(path)}/`;
      const asarEntries = [...entries]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
        .filter((entry) => entry && !entry.includes('/'))
        .map((entry) => basename(entry));
      if (asarEntries.length > 0) return asarEntries;
      try {
        return await readdir(join(resourceRoot, path));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

function createDirectoryAppReader(appRoot) {
  return {
    isAsar: false,
    label: relative(repoRoot, appRoot),
    exists(path) {
      return exists(join(appRoot, path));
    },
    async isDirectory(path) {
      try {
        return (await stat(join(appRoot, path))).isDirectory();
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
    readJson(path) {
      return readJson(join(appRoot, path));
    },
    readText(path) {
      return readFile(join(appRoot, path), 'utf8');
    },
    readBuffer(path) {
      return readFile(join(appRoot, path));
    },
    async listDir(path) {
      try {
        return await readdir(join(appRoot, path));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },
    async isUnpacked() {
      return false;
    },
  };
}

async function checkExists(app, path, label, failures) {
  if (await app.exists(path)) return;
  failures.push(`Missing ${label}: ${path}`);
}

async function checkNoVscodeRuntimeImport(app, failures) {
  for (const bundlePath of await collectMainJavaScriptBundles(app)) {
    const mainBundle = await app.readText(bundlePath);
    if (!vscodeRuntimeImportPattern.test(mainBundle)) continue;
    failures.push(
      `Packaged desktop main bundle contains a runtime import of the VS Code extension host module: ${bundlePath}`,
    );
  }
}

async function checkDesktopMainDynamicRequireShim(app, failures) {
  for (const bundlePath of await collectMainJavaScriptBundles(app)) {
    const mainBundle = await app.readText(bundlePath);
    if (!mainBundle.includes('Dynamic require of')) continue;
    if (mainBundle.includes('__texraCreateRequire(import.meta.url)')) continue;

    failures.push(
      `Packaged desktop main bundle contains esbuild dynamic require calls without the Node createRequire shim: ${bundlePath}`,
    );
  }
}

async function collectMainJavaScriptBundles(app, dir = 'dist/main') {
  const entries = await app.listDir(dir);
  const bundles = [];
  for (const entry of entries) {
    const entryPath = posix.join(dir, entry);
    if (entry.endsWith('.js')) {
      bundles.push(entryPath);
    } else if (await app.isDirectory(entryPath)) {
      bundles.push(...(await collectMainJavaScriptBundles(app, entryPath)));
    }
  }
  return bundles.sort();
}

function parseStaticRelativeImports(source) {
  const imports = [];
  const staticImportPattern =
    /^(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+(?:\*|{[^}]*}|\*\s+as\s+\w+)\s+from\s+)['"](\.\/[^'"]+)['"];?/gm;
  for (const match of source.matchAll(staticImportPattern)) {
    imports.push(match[1]);
  }
  return imports;
}

function parseDynamicRelativeImports(source) {
  const imports = [];
  const dynamicImportPattern = /import\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(dynamicImportPattern)) {
    imports.push(match[1]);
  }
  return imports;
}

async function checkDesktopStartupBundles(app, failures) {
  const entryPath = 'dist/main/index.js';
  if (!(await app.exists(entryPath))) return;

  const pending = [entryPath];
  const visited = new Set();
  while (pending.length > 0) {
    const bundlePath = pending.shift();
    if (!bundlePath || visited.has(bundlePath)) continue;
    visited.add(bundlePath);

    const source = await app.readText(bundlePath);
    const forbidden = desktopStartupForbiddenBundleMarkers.filter(
      ({ patterns }) => patterns.some((pattern) => source.includes(pattern)),
    );
    if (forbidden.length > 0) {
      failures.push(
        `Packaged desktop startup bundle eagerly includes provider SDK code (${forbidden
          .map(({ label }) => label)
          .join(', ')}): ${bundlePath}`,
      );
    }

    const imports = parseStaticRelativeImports(source);
    if (bundlePath === entryPath) {
      const dynamicImports = parseDynamicRelativeImports(source);
      if (dynamicImports.length !== 1) {
        failures.push(
          `Packaged desktop bootstrap entry should have exactly one startup dynamic import, found ${dynamicImports.length}.`,
        );
      }
      imports.push(...dynamicImports);
    }
    for (const specifier of imports) {
      const importedPath = posix.normalize(
        posix.join(posix.dirname(bundlePath), specifier),
      );
      if (await app.exists(importedPath)) {
        pending.push(importedPath);
      }
    }
  }
}

async function checkDesktopSourceBoundaries(failures) {
  for (const dir of desktopSourceBoundaryDirs) {
    if (!(await exists(dir))) continue;
    for (const filePath of await collectFiles(dir)) {
      if (!/\.[cm]?tsx?$/.test(filePath)) continue;
      const source = await readFile(filePath, 'utf8');
      if (
        desktopSharedSourceDirSet.has(dir) &&
        vscodeBackedStateImportPattern.test(source)
      ) {
        failures.push(
          `Desktop-shared source imports the VS Code-backed state barrel instead of @common/state/stateKeys: ${relative(
            repoRoot,
            filePath,
          )}`,
        );
      }
      if (
        desktopVscodeFreeSourceDirSet.has(dir) &&
        vscodeRuntimeImportPattern.test(source)
      ) {
        failures.push(
          `Desktop-shared source imports the VS Code runtime module: ${relative(
            repoRoot,
            filePath,
          )}`,
        );
      }
    }
  }
}

function dependencyPackageJsonPath(name) {
  return join('node_modules', name, 'package.json');
}

function codexBinaryPath(prefix, platformInfo) {
  return posix.join(
    prefix,
    'node_modules',
    ...platformInfo.pkg.split('/'),
    'vendor',
    platformInfo.triple,
    'codex',
    platformInfo.binaryName,
  );
}

function expectedCodexPlatformKeys(app) {
  const label = app.label.replaceAll('\\', '/').toLowerCase();
  if (label.includes('.app/contents/resources/app')) {
    return ['darwin-x64', 'darwin-arm64'];
  }

  if (label.includes('linux')) {
    return [
      label.includes('arm64') || label.includes('aarch64')
        ? 'linux-arm64'
        : 'linux-x64',
    ];
  }

  if (label.includes('win')) {
    return [
      label.includes('arm64') || label.includes('aarch64')
        ? 'win32-arm64'
        : 'win32-x64',
    ];
  }

  return [];
}

async function checkCodexUnpackedBinaries(app, failures) {
  const platformKeys = expectedCodexPlatformKeys(app);
  if (platformKeys.length === 0) {
    failures.push(
      `Could not infer expected Codex CLI platform from packaged app path: ${app.label}`,
    );
    return false;
  }

  for (const platformKey of platformKeys) {
    const platformInfo = codexPlatformInfoByKey[platformKey];
    const unpackedBinaryPath = codexBinaryPath(
      'app.asar.unpacked',
      platformInfo,
    );
    if (!(await app.exists(unpackedBinaryPath))) {
      failures.push(
        `Packaged desktop app is missing the unpacked Codex CLI binary for ${platformKey}: ${unpackedBinaryPath}`,
      );
      continue;
    }

    const archivedBinaryPath = codexBinaryPath('', platformInfo);
    if (
      app.isAsar &&
      (await app.exists(archivedBinaryPath)) &&
      !(await app.isUnpacked(archivedBinaryPath))
    ) {
      failures.push(
        `Packaged desktop app keeps the Codex CLI binary inside app.asar for ${platformKey}; it must be unpacked: ${archivedBinaryPath}`,
      );
    }
  }

  return true;
}

async function checkRuntimeDependencies(app, appPackageJson, failures) {
  const sourcePackageJson = await readJson(desktopPackageJsonPath);
  const sourceDependencies = sourcePackageJson.dependencies ?? {};
  const packagedDependencies = appPackageJson.dependencies ?? {};

  const missingDeclarations = [];
  const versionMismatches = [];
  for (const [name, version] of Object.entries(sourceDependencies)) {
    if (!Object.hasOwn(packagedDependencies, name)) {
      missingDeclarations.push(name);
    } else if (packagedDependencies[name] !== version) {
      versionMismatches.push(
        `${name} (expected ${version}, got ${packagedDependencies[name]})`,
      );
    }
  }
  if (missingDeclarations.length > 0) {
    failures.push(
      `Packaged app package.json is missing runtime dependency declarations: ${missingDeclarations.join(
        ', ',
      )}`,
    );
  }
  if (versionMismatches.length > 0) {
    failures.push(
      `Packaged app package.json has runtime dependency version mismatches: ${versionMismatches.join(
        ', ',
      )}`,
    );
  }

  const missingPackages = [];
  for (const name of Object.keys(sourceDependencies)) {
    if (!(await app.exists(dependencyPackageJsonPath(name)))) {
      missingPackages.push(name);
    }
  }
  if (missingPackages.length > 0) {
    failures.push(
      `Packaged app is missing runtime dependency packages: ${missingPackages.join(
        ', ',
      )}`,
    );
  }
}

async function checkBundledResources(app, failures) {
  for (const directoryName of bundledAgentResourceDirs) {
    const entries = await app.listDir(`resources/${directoryName}`);
    if (entries.length === 0) {
      failures.push(
        `Packaged app is missing bundled resource directory: resources/${directoryName}`,
      );
    }
  }
}

async function checkMacIcon(app, failures) {
  if (!app.label.includes('.app/Contents/Resources/app.asar')) return false;

  const appIconPath = 'icon.icns';
  if (!(await app.exists(appIconPath))) {
    failures.push(`Packaged macOS app is missing TeXRA icon: ${appIconPath}`);
    return true;
  }

  const [expectedIcon, actualIcon] = await Promise.all([
    readFile(desktopIconPath),
    app.readBuffer(appIconPath),
  ]);
  if (!expectedIcon.equals(actualIcon)) {
    failures.push(
      `Packaged macOS app icon does not match source icon: ${appIconPath}`,
    );
  }
  return true;
}

const app = await findPackagedApp();
const failures = [];
let checkedMacIcon = false;
let checkedCodexUnpackedBinaries = false;

if (!app) {
  failures.push(`No packaged Electron app found under ${packageRoot}`);
} else {
  const appPackageJson = await app.readJson('package.json');

  if (appPackageJson.main !== './dist/main/index.js') {
    failures.push(
      `Packaged app main must be ./dist/main/index.js, got ${appPackageJson.main}`,
    );
  }

  await checkRuntimeDependencies(app, appPackageJson, failures);
  await checkExists(app, 'dist/main/index.js', 'main bundle', failures);
  await checkExists(app, 'dist/preload/index.cjs', 'preload bundle', failures);
  await checkExists(app, 'dist/renderer/index.html', 'renderer HTML', failures);
  await checkBundledResources(app, failures);
  checkedMacIcon = await checkMacIcon(app, failures);
  checkedCodexUnpackedBinaries = await checkCodexUnpackedBinaries(
    app,
    failures,
  );
  await checkNoVscodeRuntimeImport(app, failures);
  await checkDesktopMainDynamicRequireShim(app, failures);
  await checkDesktopStartupBundles(app, failures);

  const assets = await app.listDir('dist/renderer/assets');
  if (!assets.some((asset) => asset.endsWith('.js'))) {
    failures.push('No renderer JavaScript asset found');
  }
  if (!assets.some((asset) => asset.endsWith('.css'))) {
    failures.push('No renderer CSS asset found');
  }
}

await checkDesktopSourceBoundaries(failures);

if (failures.length > 0) {
  console.error('Desktop package check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const summary = [
  `Desktop package check passed for ${app.label}`,
  '- dist/main/index.js',
  '- dist/preload/index.cjs',
  '- dist/renderer/index.html',
  '- dist/renderer/assets/*.js',
  '- dist/renderer/assets/*.css',
  '- resources/agents and resources/tool_use_agents',
  '- package.json runtime dependencies',
  '- node_modules runtime dependency packages',
  '- no VS Code extension host runtime import',
  '- desktop main dynamic require shim',
  '- desktop startup bundles exclude provider SDKs',
  '- desktop-shared source uses vscode-free state keys',
  '- desktop-shared source avoids VS Code runtime imports',
];

if (checkedMacIcon) summary.splice(7, 0, '- macOS app icon');
if (checkedCodexUnpackedBinaries) {
  summary.splice(
    checkedMacIcon ? 8 : 7,
    0,
    '- unpacked Codex CLI platform binaries',
  );
}

console.log(summary.join('\n'));
