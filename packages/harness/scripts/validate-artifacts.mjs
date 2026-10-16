import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkForgottenExports } from './forgotten-exports.mjs';
import {
  isFile,
  moduleSpecifier,
  reachableDeclarations,
  readDeclaration,
  walkFiles,
} from './fsWalk.mjs';

// The built package to check: this package, or the one a build names (the
// llm build passes its own root). Each is checked against what it publishes:
// `publishConfig.exports` when the workspace `exports` name sources.
const packageRoot = path.resolve(
  process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)),
);
const repositoryRoot = path.resolve(packageRoot, '../..');
const distRoot = path.join(packageRoot, 'dist');
const manifest = JSON.parse(
  await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
);
const rootTsconfig = JSON.parse(
  await readFile(path.join(repositoryRoot, 'tsconfig.json'), 'utf8'),
);

// The code entries: `./package.json` exports the manifest itself.
const publishedExports = Object.fromEntries(
  Object.entries(manifest.publishConfig?.exports ?? manifest.exports).filter(
    ([, target]) => typeof target !== 'string',
  ),
);
// tsc emits a declaration for every source file in the program, the
// implementation's imports included. The package ships the declarations its
// published entries reach and no others: an unreachable one is dead weight,
// and its imports (a devDependency's types, a bundled vendor's) would not
// resolve for a consumer who type-checks the whole package.
const entryGraphs = new Map();
for (const [entry, target] of Object.entries(publishedExports)) {
  entryGraphs.set(
    entry,
    await reachableDeclarations(path.resolve(packageRoot, target.types)),
  );
}
const shipped = new Set(
  [...entryGraphs.values()].flatMap((graph) => [...graph]),
);
const unreachable = (await walkFiles(distRoot)).filter(
  (file) => /\.d\.m?ts$/u.test(file) && !shipped.has(file),
);
await Promise.all(unreachable.map((file) => rm(file)));

const allFiles = await walkFiles(distRoot);
const declarationFiles = allFiles.filter((file) => /\.d\.m?ts$/u.test(file));
const declarationText = (
  await Promise.all(declarationFiles.map(readDeclaration))
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
// Specifier positions only: a service key such as `'@texra/platform/AppState'`
// is a string, not an import of the `@texra/*` alias.
for (const alias of internalAliases) {
  const quotedAlias = new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)['"]${alias.replaceAll('/', '\\/')}(?:/|['"])`,
  );
  if (quotedAlias.test(declarationText)) {
    throw new Error(`Unresolved internal declaration alias remains: ${alias}`);
  }
}
const distManifestPath = path.join(distRoot, 'package.json');
const distType = (await isFile(distManifestPath))
  ? JSON.parse(await readFile(distManifestPath, 'utf8')).type
  : manifest.type;
if (distType !== 'module') {
  throw new Error('The package must mark its built output as ESM.');
}
if (allFiles.some((file) => file.endsWith('.map'))) {
  throw new Error('Source or declaration maps must not be published.');
}

function packageName(specifier) {
  if (specifier.startsWith('@'))
    return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

const declaredPackages = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const importedPackages = new Set();

for (const declaration of declarationFiles) {
  const source = await readDeclaration(declaration);
  for (const match of source.matchAll(moduleSpecifier)) {
    const specifier = match.groups?.specifier;
    if (!specifier) continue;
    if (specifier.startsWith('.')) {
      if (!/\.m?js$/u.test(specifier)) {
        throw new Error(
          `NodeNext declaration specifier lacks a .js extension: ${declaration}: ${specifier}`,
        );
      }
      continue;
    }
    // A bare specifier in a shipped declaration has to resolve from the
    // installed tarball. A workspace package that is private, or simply not a
    // dependency, resolves in this repository and nowhere else, so the types
    // break on arrival rather than here. The tsconfig alias check above cannot
    // see these: they are package names, not `paths` entries.
    if (specifier.startsWith('node:')) continue;
    importedPackages.add(packageName(specifier));
    if (!declaredPackages.has(packageName(specifier))) {
      throw new Error(
        `Declaration imports an undeclared package: ${declaration}: ${specifier}`,
      );
    }
  }
}

// Every published entry, not only the root: an entry whose declaration
// graph reaches a provider SDK puts that provider's types back on the
// published surface however narrow the entry looks.
for (const [entry, entryGraph] of entryGraphs) {
  const entryGraphText = (
    await Promise.all([...entryGraph].map(readDeclaration))
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
    if (providerImport.test(entryGraphText)) {
      throw new Error(
        `Provider type leaked into the "${entry}" entry: ${provider}`,
      );
    }
  }
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
    importedPackages.add(packageName(specifier));
  }
}
const missingPackages = [...externalPackages]
  .filter((dependency) => !declaredPackages.has(dependency))
  .toSorted();
if (missingPackages.length > 0) {
  throw new Error(
    `Bundled entries import undeclared packages: ${missingPackages.join(', ')}`,
  );
}
// A dependency nothing shipped imports (one the bundle inlines, or a
// build-time tool) is a devDependency: every consumer would install it for
// nothing.
const unusedPackages = Object.keys(manifest.dependencies ?? {})
  .filter((dependency) => !importedPackages.has(dependency))
  .toSorted();
if (unusedPackages.length > 0) {
  throw new Error(
    `Dependencies nothing shipped imports: ${unusedPackages.join(', ')}`,
  );
}
if (externalPackages.has('openai')) {
  throw new Error(
    'The bundle must carry the repository-patched OpenAI runtime.',
  );
}

await checkForgottenExports({
  repositoryRoot,
  packageRoot,
  distRoot,
  entries: Object.values(publishedExports).map((target) =>
    path.resolve(packageRoot, target.types),
  ),
});

console.log(
  `Validated ${declarationFiles.length} declarations (${unreachable.length} no entry reaches removed) and ${externalPackages.size} external packages.`,
);
