import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  getDesktopSharedSourceDirs,
  getDesktopVscodeFreeSourceDirs,
  vscodeBackedStateImportPattern,
  vscodeRuntimeImportPattern,
} from './extension-package-utils.mjs';

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require('@electron/asar');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = join(repoRoot, 'packages', 'desktop');
const packageRoot = join(desktopRoot, 'dist-packaged');
const desktopPackageJsonPath = join(desktopRoot, 'package.json');
const desktopSharedSourceDirs = getDesktopSharedSourceDirs(repoRoot);
const desktopVscodeFreeSourceDirs = getDesktopVscodeFreeSourceDirs(repoRoot);

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
  return `/${path.replaceAll('\\', '/')}`;
}

function createAsarAppReader(asarPath) {
  const entries = new Set(listPackage(asarPath));
  return {
    label: relative(repoRoot, asarPath),
    async exists(path) {
      return entries.has(normalizeAsarPath(path));
    },
    async readJson(path) {
      return JSON.parse(extractFile(asarPath, path).toString('utf8'));
    },
    async readText(path) {
      return extractFile(asarPath, path).toString('utf8');
    },
    async listDir(path) {
      const prefix = `${normalizeAsarPath(path)}/`;
      return [...entries]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
        .filter((entry) => entry && !entry.includes('/'))
        .map((entry) => basename(entry));
    },
  };
}

function createDirectoryAppReader(appRoot) {
  return {
    label: relative(repoRoot, appRoot),
    exists(path) {
      return exists(join(appRoot, path));
    },
    readJson(path) {
      return readJson(join(appRoot, path));
    },
    readText(path) {
      return readFile(join(appRoot, path), 'utf8');
    },
    async listDir(path) {
      try {
        return await readdir(join(appRoot, path));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

async function checkExists(app, path, label, failures) {
  if (await app.exists(path)) return;
  failures.push(`Missing ${label}: ${path}`);
}

async function checkNoVscodeRuntimeImport(app, failures) {
  const mainBundlePath = 'dist/main/index.js';
  if (!(await app.exists(mainBundlePath))) return;
  const mainBundle = await app.readText(mainBundlePath);
  if (!vscodeRuntimeImportPattern.test(mainBundle)) return;
  failures.push(
    'Packaged desktop main bundle contains a runtime import of the VS Code extension host module.',
  );
}

async function checkDesktopSourceBoundaries(failures) {
  for (const dir of desktopSharedSourceDirs) {
    if (!(await exists(dir))) continue;
    for (const filePath of await collectFiles(dir)) {
      if (!/\.[cm]?tsx?$/.test(filePath)) continue;
      if (
        !vscodeBackedStateImportPattern.test(await readFile(filePath, 'utf8'))
      ) {
        continue;
      }
      failures.push(
        `Desktop-shared source imports the VS Code-backed state barrel instead of @common/state/stateKeys: ${relative(
          repoRoot,
          filePath,
        )}`,
      );
    }
  }

  for (const dir of desktopVscodeFreeSourceDirs) {
    if (!(await exists(dir))) continue;
    for (const filePath of await collectFiles(dir)) {
      if (!/\.[cm]?tsx?$/.test(filePath)) continue;
      if (!vscodeRuntimeImportPattern.test(await readFile(filePath, 'utf8')))
        continue;
      failures.push(
        `Desktop-shared source imports the VS Code runtime module: ${relative(
          repoRoot,
          filePath,
        )}`,
      );
    }
  }
}

function dependencyPackageJsonPath(name) {
  return join('node_modules', name, 'package.json');
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

const app = await findPackagedApp();
const failures = [];

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
  await checkNoVscodeRuntimeImport(app, failures);

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

console.log(
  [
    `Desktop package check passed for ${app.label}`,
    '- dist/main/index.js',
    '- dist/preload/index.cjs',
    '- dist/renderer/index.html',
    '- dist/renderer/assets/*.js',
    '- dist/renderer/assets/*.css',
    '- package.json runtime dependencies',
    '- node_modules runtime dependency packages',
    '- no VS Code extension host runtime import',
    '- desktop-shared source uses vscode-free state keys',
    '- desktop-shared source avoids VS Code runtime imports',
  ].join('\n'),
);
