import { access, readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, posix, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  getDesktopSharedSourceDirs,
  getDesktopVscodeFreeSourceDirs,
  requiredMonacoWorkers,
  vscodeBackedStateImportPattern,
  vscodeRuntimeImportPattern,
} from './extension-package-utils.mjs';
import {
  normalizeMetafilePath,
  resolveMetafileImportPath,
} from './desktop-package-metafile-paths.mjs';

const require = createRequire(import.meta.url);
const { extractFile, listPackage, statFile } = require('@electron/asar');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = join(repoRoot, 'packages', 'desktop');
const packageRoot =
  process.env.TEXRA_DESKTOP_PACKAGE_ROOT ?? join(desktopRoot, 'dist-packaged');
const desktopPackageJsonPath = join(desktopRoot, 'package.json');
const desktopIconPath = join(desktopRoot, 'build', 'icon.icns');
const desktopSharedSourceDirs = getDesktopSharedSourceDirs(repoRoot);
const desktopVscodeFreeSourceDirs = getDesktopVscodeFreeSourceDirs(repoRoot);
const desktopSharedSourceDirSet = new Set(desktopSharedSourceDirs);
const desktopVscodeFreeSourceDirSet = new Set(desktopVscodeFreeSourceDirs);
const desktopSourceBoundaryDirs = [
  ...new Set([...desktopSharedSourceDirs, ...desktopVscodeFreeSourceDirs]),
];
const bundledRuntimeResourceDirs = ['agents', 'tool_use_agents', 'skills'];
// The Codex and Claude Code SDKs each pull a per-platform package carrying a
// 250-410 MiB native CLI binary. The desktop app resolves a user-installed CLI
// at runtime (src/tools/codexImport.ts, src/tools/claudeAgentImport.ts), so
// none of these packages may ship inside the app — keeping the SDKs in
// devDependencies is what stops electron-builder from copying them.
const forbiddenNativeCliPackages = [
  {
    label: 'OpenAI Codex CLI',
    scope: '@openai',
    isPackageDirName: (name) => name === 'codex' || name.startsWith('codex-'),
    pnpmStorePrefix: '@openai+codex',
  },
  {
    label: 'Claude Code CLI',
    scope: '@anthropic-ai',
    isPackageDirName: (name) => name.startsWith('claude-agent-sdk'),
    pnpmStorePrefix: '@anthropic-ai+claude-agent-sdk',
  },
];
const nativeCliNodeModulesRoots = [
  'node_modules',
  'app.asar.unpacked/node_modules',
];
const desktopStartupForbiddenInputPackages = [
  {
    label: '@google/genai',
    patterns: [
      /(?:^|[/\\])node_modules[/\\](?:\.pnpm[/\\][^/\\]*@google\+genai[^/\\]*[/\\]node_modules[/\\])?@google[/\\]genai[/\\]/,
      /(?:^|[/\\])node_modules[/\\](?:\.pnpm[/\\][^/\\]*google-auth-library[^/\\]*[/\\]node_modules[/\\])?google-auth-library[/\\]/,
    ],
  },
  {
    label: 'OpenAI SDK',
    patterns: [
      /(?:^|[/\\])node_modules[/\\](?:\.pnpm[/\\][^/\\]*openai@[^/\\]*[/\\]node_modules[/\\])?openai[/\\]/,
    ],
  },
  {
    label: 'Anthropic SDK',
    patterns: [
      /(?:^|[/\\])node_modules[/\\](?:\.pnpm[/\\][^/\\]*@anthropic-ai\+sdk[^/\\]*[/\\]node_modules[/\\])?@anthropic-ai[/\\]sdk[/\\]/,
    ],
  },
];
const desktopStartupEntryPoints = new Set([
  'src/main/bootstrap.ts',
  'src/main/index.ts',
]);
const desktopStartupDynamicImportEntryPoints = new Set([
  'src/main/bootstrap.ts',
]);
const desktopStartupImportKinds = new Set([
  'dynamic-import',
  'import-statement',
]);

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

function mergeDirectoryEntries(...entryGroups) {
  return [...new Set(entryGroups.flat())].sort((left, right) =>
    left.localeCompare(right),
  );
}

function isDesktopStartupEntryPoint(entryPoint) {
  const normalizedEntryPoint = normalizeMetafilePath(entryPoint);
  return hasMetafileEntryPointSuffix(
    normalizedEntryPoint,
    desktopStartupEntryPoints,
  );
}

function hasMetafileEntryPointSuffix(
  normalizedEntryPoint,
  expectedEntryPoints,
) {
  for (const expectedEntryPoint of expectedEntryPoints) {
    if (
      normalizedEntryPoint === expectedEntryPoint ||
      normalizedEntryPoint.endsWith(`/${expectedEntryPoint}`)
    ) {
      return true;
    }
  }
  return false;
}

function shouldTraverseStartupImport(output, importedOutput) {
  if (importedOutput.external) return false;
  if (importedOutput.kind === 'import-statement') return true;
  if (importedOutput.kind !== 'dynamic-import') return false;

  return hasMetafileEntryPointSuffix(
    normalizeMetafilePath(output.entryPoint ?? ''),
    desktopStartupDynamicImportEntryPoints,
  );
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
        // statFile throws when the path is not in the archive; try the next
        // normalized candidate before giving up.
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
    fsPath(path) {
      return join(resourceRoot, path);
    },
    async listDir(path) {
      const prefix = `${normalizeAsarPath(path)}/`;
      const asarEntries = [...entries]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
        .filter((entry) => entry && !entry.includes('/'))
        .map((entry) => basename(entry));
      try {
        const resourceEntries = await readdir(join(resourceRoot, path));
        return mergeDirectoryEntries(asarEntries, resourceEntries);
      } catch (error) {
        if (error?.code === 'ENOENT') return mergeDirectoryEntries(asarEntries);
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
    fsPath(path) {
      return join(appRoot, path);
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
    if (
      mainBundle.includes('__texraCreateRequire(import.meta.url)') &&
      mainBundle.includes(
        'const __filename = __texraFileURLToPath(import.meta.url);',
      ) &&
      mainBundle.includes('const __dirname = __texraDirname(__filename);')
    ) {
      continue;
    }

    failures.push(
      `Packaged desktop main bundle contains esbuild dynamic require calls without the shared ESM CommonJS-globals shim: ${bundlePath}`,
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

async function checkDesktopStartupBundles(app, failures) {
  const entryPath = 'dist/main/index.js';
  const metafilePath = 'dist/main/metafile.json';
  if (!(await app.exists(entryPath))) return;
  if (!(await app.exists(metafilePath))) {
    failures.push(
      `Packaged desktop app is missing the esbuild metafile used to verify startup imports: ${metafilePath}`,
    );
    return;
  }

  const metafile = await app.readJson(metafilePath);
  const outputByPath = new Map();
  for (const [outputPath, output] of Object.entries(metafile.outputs ?? {})) {
    outputByPath.set(normalizeMetafilePath(outputPath), output);
  }

  const pending = [];
  for (const [outputPath, output] of outputByPath) {
    if (isDesktopStartupEntryPoint(output.entryPoint ?? '')) {
      pending.push(outputPath);
    }
  }
  if (pending.length === 0) {
    failures.push(
      `Packaged desktop startup graph is missing expected esbuild entry points: ${[
        ...desktopStartupEntryPoints,
      ].join(', ')}`,
    );
    return;
  }

  const visitedOutputs = new Set();
  const startupInputsByForbiddenLabel = new Map();
  while (pending.length > 0) {
    const outputPath = pending.shift();
    if (!outputPath || visitedOutputs.has(outputPath)) continue;
    visitedOutputs.add(outputPath);

    const output = outputByPath.get(normalizeMetafilePath(outputPath));
    if (!output) {
      failures.push(
        `Packaged desktop startup bundle is missing from the esbuild metafile: ${outputPath}`,
      );
      continue;
    }

    for (const inputPath of Object.keys(output.inputs ?? {})) {
      const normalizedInput = normalizeMetafilePath(inputPath);
      for (const { label, patterns } of desktopStartupForbiddenInputPackages) {
        if (!patterns.some((pattern) => pattern.test(normalizedInput))) {
          continue;
        }
        const inputPaths = startupInputsByForbiddenLabel.get(label) ?? [];
        inputPaths.push(normalizedInput);
        startupInputsByForbiddenLabel.set(label, inputPaths);
      }
    }

    for (const importedOutput of output.imports ?? []) {
      if (!desktopStartupImportKinds.has(importedOutput.kind)) continue;
      if (!shouldTraverseStartupImport(output, importedOutput)) continue;
      const importedPath = resolveMetafileImportPath(
        outputPath,
        importedOutput.path,
      );
      if (outputByPath.has(importedPath)) pending.push(importedPath);
    }
  }

  for (const [label, inputPaths] of startupInputsByForbiddenLabel) {
    failures.push(
      `Packaged desktop startup graph eagerly includes provider SDK code (${label}): ${[
        ...new Set(inputPaths),
      ].join(', ')}`,
    );
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

async function checkNoBundledNativeCliPayload(app, failures) {
  const bundled = [];

  for (const nodeModulesRoot of nativeCliNodeModulesRoots) {
    for (const cli of forbiddenNativeCliPackages) {
      for (const entry of await app.listDir(
        posix.join(nodeModulesRoot, cli.scope),
      )) {
        if (!cli.isPackageDirName(entry)) continue;
        bundled.push({
          cli,
          path: posix.join(nodeModulesRoot, cli.scope, entry),
        });
      }

      for (const entry of await app.listDir(
        posix.join(nodeModulesRoot, '.pnpm'),
      )) {
        if (!entry.startsWith(cli.pnpmStorePrefix)) continue;
        bundled.push({
          cli,
          path: posix.join(nodeModulesRoot, '.pnpm', entry),
        });
      }
    }
  }

  if (bundled.length === 0) return;

  const described = [];
  for (const { cli, path } of bundled) {
    const sizeBytes = await onDiskSize(app.fsPath(path));
    described.push(
      `${cli.label} at ${path}${sizeBytes == null ? '' : ` (${formatBytes(sizeBytes)})`}`,
    );
  }

  failures.push(
    'Packaged desktop app bundles native CLI payloads that must be installed ' +
      'by the user instead. Keep the SDKs in devDependencies so ' +
      `electron-builder never copies their platform packages: ${described.join('; ')}`,
  );
}

async function onDiskSize(path) {
  let entryStat;
  try {
    entryStat = await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!entryStat.isDirectory()) return entryStat.size;

  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childSize = await onDiskSize(join(path, entry.name));
    if (childSize != null) total += childSize;
  }
  return total;
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
  for (const directoryName of bundledRuntimeResourceDirs) {
    const entries = await app.listDir(`resources/${directoryName}`);
    if (entries.length === 0) {
      failures.push(
        `Packaged app is missing bundled resource directory: resources/${directoryName}`,
      );
    }
  }

  await checkExists(
    app,
    'resources/traceViewer/index.html',
    'trace-viewer HTML template',
    failures,
  );
}

async function checkMonacoWorkerAssets(app, failures) {
  const assets = await app.listDir('dist/renderer/assets');
  for (const workerName of requiredMonacoWorkers) {
    if (!assets.some((asset) => asset.includes(workerName))) {
      failures.push(
        `Packaged desktop app is missing Monaco worker asset: dist/renderer/assets/${workerName}*.js`,
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
  await checkMonacoWorkerAssets(app, failures);
  checkedMacIcon = await checkMacIcon(app, failures);
  await checkNoBundledNativeCliPayload(app, failures);
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
  '- dist/renderer/assets Monaco worker chunks',
  '- resources/agents, resources/tool_use_agents, and resources/skills',
  '- resources/traceViewer/index.html',
  '- package.json runtime dependencies',
  '- node_modules runtime dependency packages',
  '- no bundled Codex or Claude Code CLI payload',
  '- no VS Code extension host runtime import',
  '- desktop main dynamic require shim',
  '- desktop startup import graph excludes provider SDKs',
  '- desktop-shared source uses vscode-free state keys',
  '- desktop-shared source avoids VS Code runtime imports',
];

if (checkedMacIcon) summary.splice(7, 0, '- macOS app icon');

console.log(summary.join('\n'));
