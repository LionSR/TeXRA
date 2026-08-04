import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '../..');
const distRoot = path.join(packageRoot, 'dist');
const manifest = JSON.parse(
  await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
);
const rootTsconfig = JSON.parse(
  await readFile(path.join(repositoryRoot, 'tsconfig.json'), 'utf8'),
);

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    }),
  );
  return nested.flat();
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

const allFiles = await filesBelow(distRoot);
const declarationFiles = allFiles.filter((file) => file.endsWith('.d.ts'));
const declarationText = (
  await Promise.all(declarationFiles.map((file) => readFile(file, 'utf8')))
).join('\n');
const internalAliases = Object.entries(rootTsconfig.compilerOptions.paths)
  .filter(([, targets]) =>
    targets.some(
      (target) => !target.replace(/^\.\//u, '').startsWith('node_modules/'),
    ),
  )
  .map(([pattern]) => pattern.replace(/\/\*$/u, ''));

for (const forbidden of [
  'packages/extension/src/',
  "from 'vscode'",
  'from "vscode"',
  "import('vscode')",
  'import("vscode")',
]) {
  if (declarationText.includes(forbidden)) {
    throw new Error(`Forbidden declaration text remains: ${forbidden}`);
  }
}
for (const alias of internalAliases) {
  const quotedAlias = new RegExp(
    `['"]${alias.replaceAll('/', '\\/')}(?:/|['"])`,
  );
  if (quotedAlias.test(declarationText)) {
    throw new Error(`Unresolved internal declaration alias remains: ${alias}`);
  }
}
if (allFiles.some((file) => file.endsWith('.map'))) {
  throw new Error('Source or declaration maps must not be published.');
}

const moduleSpecifier =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(?<quote>['"])(?<specifier>[^'"]+)\k<quote>/gu;

for (const declaration of declarationFiles) {
  const source = await readFile(declaration, 'utf8');
  for (const match of source.matchAll(moduleSpecifier)) {
    const specifier = match.groups?.specifier;
    if (specifier?.startsWith('.') && !specifier.endsWith('.js')) {
      throw new Error(
        `NodeNext declaration specifier lacks a .js extension: ${declaration}: ${specifier}`,
      );
    }
  }
}

async function reachableDeclarations(entry) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const declaration = pending.pop();
    if (!declaration || visited.has(declaration)) continue;
    visited.add(declaration);
    const source = await readFile(declaration, 'utf8');
    for (const match of source.matchAll(moduleSpecifier)) {
      const specifier = match.groups?.specifier;
      if (!specifier?.startsWith('.')) continue;
      let target = path.resolve(
        path.dirname(declaration),
        specifier.replace(/\.js$/u, '.d.ts'),
      );
      if (!(await isFile(target)) && path.extname(target) === '') {
        target = `${target}.d.ts`;
      }
      if (!(await isFile(target))) {
        throw new Error(
          `Declaration ${declaration} refers to missing target ${specifier}`,
        );
      }
      pending.push(target);
    }
  }
  return visited;
}

const mainTypes = path.resolve(packageRoot, manifest.exports['.'].types);
const mainGraph = await reachableDeclarations(mainTypes);
const mainGraphText = (
  await Promise.all([...mainGraph].map((file) => readFile(file, 'utf8')))
).join('\n');
for (const provider of [
  '@anthropic-ai/sdk',
  '@google/genai',
  '@openrouter/sdk',
  'openai',
]) {
  const providerImport = new RegExp(
    `(?:from|import\\s*\\()\\s*['"]${provider.replaceAll('/', '\\/')}(?:/|['"])`,
  );
  if (providerImport.test(mainGraphText)) {
    throw new Error(`Provider type leaked into the main entry: ${provider}`);
  }
}

function packageName(specifier) {
  if (specifier.startsWith('@'))
    return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

const externalPackages = new Set();
const javascriptImport =
  /(?:^\s*import(?:[^'"]*?\bfrom\s*)?|\bimport\s*\(\s*)(?<quote>['"])(?<specifier>[^'"]+)\k<quote>/gmu;
for (const javascript of allFiles.filter((file) => file.endsWith('.js'))) {
  const source = await readFile(javascript, 'utf8');
  for (const match of source.matchAll(javascriptImport)) {
    const specifier = match.groups?.specifier;
    if (
      !specifier ||
      specifier.startsWith('.') ||
      specifier.startsWith('node:')
    ) {
      continue;
    }
    externalPackages.add(packageName(specifier));
  }
}
const declaredPackages = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const missingPackages = [...externalPackages]
  .filter((dependency) => !declaredPackages.has(dependency))
  .toSorted();
if (missingPackages.length > 0) {
  throw new Error(
    `Bundled entries import undeclared packages: ${missingPackages.join(', ')}`,
  );
}
if (externalPackages.has('openai')) {
  throw new Error(
    'The agent bundle must carry the repository-patched OpenAI runtime.',
  );
}

console.log(
  `Validated ${declarationFiles.length} declarations and ${externalPackages.size} external packages.`,
);
