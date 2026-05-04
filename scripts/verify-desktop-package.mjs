import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require('@electron/asar');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = join(repoRoot, 'packages', 'desktop');
const packageRoot = join(desktopRoot, 'dist-packaged');
const desktopPackageJsonPath = join(desktopRoot, 'package.json');

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
  throw new Error(`No packaged Electron app found under ${packageRoot}`);
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
    listDir(path) {
      return readdir(join(appRoot, path));
    },
  };
}

async function assertExists(app, path, label) {
  if (await app.exists(path)) return;
  throw new Error(`Missing ${label}: ${path}`);
}

function dependencyPackageJsonPath(name) {
  return join('node_modules', name, 'package.json');
}

async function assertRuntimeDependencies(app, appPackageJson) {
  const sourcePackageJson = await readJson(desktopPackageJsonPath);
  const sourceDependencies = sourcePackageJson.dependencies ?? {};
  const packagedDependencies = appPackageJson.dependencies ?? {};
  const mismatched = Object.keys(sourceDependencies).filter(
    (name) => packagedDependencies[name] !== sourceDependencies[name],
  );
  if (mismatched.length > 0) {
    throw new Error(
      `Packaged app is missing declared runtime dependencies: ${mismatched.join(
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
    throw new Error(
      `Packaged app is missing runtime dependency packages: ${missingPackages.join(
        ', ',
      )}`,
    );
  }
}

const app = await findPackagedApp();
const appPackageJson = await app.readJson('package.json');

if (appPackageJson.main !== './dist/main/index.js') {
  throw new Error(
    `Packaged app main must be ./dist/main/index.js, got ${appPackageJson.main}`,
  );
}

await assertRuntimeDependencies(app, appPackageJson);
await assertExists(app, 'dist/main/index.js', 'main bundle');
await assertExists(app, 'dist/preload/index.cjs', 'preload bundle');
await assertExists(app, 'dist/renderer/index.html', 'renderer HTML');

const assets = await app.listDir('dist/renderer/assets');
if (!assets.some((asset) => asset.endsWith('.js'))) {
  throw new Error('No renderer JavaScript asset found');
}
if (!assets.some((asset) => asset.endsWith('.css'))) {
  throw new Error('No renderer CSS asset found');
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
  ].join('\n'),
);
