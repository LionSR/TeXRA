import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isFile, walkFiles } from './fsWalk.mjs';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '../..');
const outputRoot = path.join(packageRoot, 'dist/types');
const tsconfig = JSON.parse(
  await readFile(path.join(repositoryRoot, 'tsconfig.json'), 'utf8'),
);
const aliases = Object.entries(tsconfig.compilerOptions.paths).toSorted(
  ([left], [right]) => right.length - left.length,
);

// Workspace packages whose sources this build compiles into dist/types, read
// from the declaration build's own `include` so the two cannot drift. Their
// bare specifiers need rewriting for the same reason a tsconfig alias does:
// `@texra-ai/llm` is private and undeclared, so nothing resolves it from an
// installed tarball. The exports map is the only way in, so it is what we
// resolve through.
const buildTsconfig = JSON.parse(
  await readFile(path.join(repositoryRoot, 'tsconfig.build.json'), 'utf8'),
);
const workspacePackages = await Promise.all(
  buildTsconfig.include
    .map((pattern) => /^(?<directory>packages\/[^/*]+)\/src\//u.exec(pattern))
    .filter((match) => match !== null)
    .map((match) => match.groups.directory)
    .filter((directory) => directory !== 'packages/agent')
    .map(async (directory) => {
      const root = path.join(repositoryRoot, directory);
      const manifest = JSON.parse(
        await readFile(path.join(root, 'package.json'), 'utf8'),
      );
      return { name: manifest.name, root, exports: manifest.exports ?? {} };
    }),
);

function resolveWorkspaceExport(specifier) {
  for (const { name, root, exports } of workspacePackages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath =
      specifier === name ? '.' : `.${specifier.slice(name.length)}`;
    const target = exports[subpath];
    if (typeof target !== 'string') {
      throw new Error(
        `Declaration specifier ${specifier} has no ${name} exports entry.`,
      );
    }
    return path.resolve(root, target);
  }
  return undefined;
}

async function resolveSource(specifier) {
  const workspaceSource = resolveWorkspaceExport(specifier);
  if (workspaceSource) return workspaceSource;
  for (const [pattern, targets] of aliases) {
    const wildcard = pattern.endsWith('/*');
    const prefix = wildcard ? pattern.slice(0, -1) : pattern;
    if (wildcard ? !specifier.startsWith(prefix) : specifier !== pattern) {
      continue;
    }
    const suffix = wildcard ? specifier.slice(prefix.length) : '';
    for (const target of targets) {
      const candidate = path.resolve(
        repositoryRoot,
        target.replace('*', suffix),
      );
      for (const source of [
        candidate,
        candidate.replace(/\.mjs$/u, '.mts'),
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.d.ts`,
        path.join(candidate, 'index.ts'),
        path.join(candidate, 'index.tsx'),
      ]) {
        if (await isFile(source)) return source;
      }
    }
  }
  return undefined;
}

function emittedPath(sourcePath) {
  const relative = path.relative(repositoryRoot, sourcePath);
  return path
    .join(outputRoot, relative)
    .replace(/\.d\.ts$/u, '.d.ts')
    .replace(/\.tsx?$/u, '.d.ts')
    .replace(/\.mts$/u, '.d.mts');
}

const moduleSpecifier =
  /(?<prefix>\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s+\*\s+from\s*)(?<quote>['"])(?<specifier>[^'"]+)\k<quote>/gu;

async function resolveDeclarationSpecifier(specifier, declaration) {
  let emitted;
  if (specifier.startsWith('.')) {
    const candidate = path.resolve(
      path.dirname(declaration),
      specifier.replace(/\.mjs$/u, '.d.mts').replace(/\.js$/u, '.d.ts'),
    );
    emitted = (await isFile(candidate))
      ? candidate
      : (await isFile(`${candidate}.d.ts`))
        ? `${candidate}.d.ts`
        : path.join(candidate, 'index.d.ts');
  } else {
    const source = await resolveSource(specifier);
    if (!source) return undefined;
    emitted = emittedPath(source);
  }
  if (!(await isFile(emitted))) {
    throw new Error(
      `Declaration target for ${specifier} was not emitted: ${emitted}`,
    );
  }
  let relative = path.relative(path.dirname(declaration), emitted);
  relative = relative
    .replaceAll(path.sep, '/')
    .replace(/\.d\.ts$/u, '.js')
    .replace(/\.d\.mts$/u, '.mjs');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

for (const declaration of await walkFiles(outputRoot, (name) =>
  /\.d\.m?ts$/u.test(name),
)) {
  const original = await readFile(declaration, 'utf8');
  let rewritten = '';
  let cursor = 0;
  for (const match of original.matchAll(moduleSpecifier)) {
    const specifier = match.groups?.specifier;
    if (!specifier || match.index == null) continue;
    const relative = await resolveDeclarationSpecifier(specifier, declaration);
    if (!relative) continue;
    const specifierOffset = match[0].indexOf(specifier);
    const start = match.index + specifierOffset;
    rewritten += original.slice(cursor, start) + relative;
    cursor = start + specifier.length;
  }
  rewritten += original.slice(cursor);
  if (rewritten !== original) await writeFile(declaration, rewritten);
}
