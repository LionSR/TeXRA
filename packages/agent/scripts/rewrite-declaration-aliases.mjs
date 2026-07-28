import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '../..');
const outputRoot = path.join(packageRoot, 'dist/types');
const tsconfig = JSON.parse(
  await readFile(path.join(repositoryRoot, 'tsconfig.json'), 'utf8'),
);
const aliases = Object.entries(tsconfig.compilerOptions.paths)
  .filter(([, targets]) =>
    targets.every((target) => !target.startsWith('node_modules/')),
  )
  .toSorted(([left], [right]) => right.length - left.length);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSource(specifier) {
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
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.d.ts`,
        path.join(candidate, 'index.ts'),
        path.join(candidate, 'index.tsx'),
      ]) {
        if (await exists(source)) return source;
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
    .replace(/\.tsx?$/u, '.d.ts');
}

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory()
        ? declarationFiles(target)
        : entry.name.endsWith('.d.ts')
          ? [target]
          : [];
    }),
  );
  return nested.flat();
}

const moduleSpecifier =
  /(?<prefix>\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s+\*\s+from\s*)(?<quote>['"])(?<specifier>@[^'"]+)\k<quote>/gu;

for (const declaration of await declarationFiles(outputRoot)) {
  const original = await readFile(declaration, 'utf8');
  let rewritten = '';
  let cursor = 0;
  for (const match of original.matchAll(moduleSpecifier)) {
    const specifier = match.groups?.specifier;
    if (!specifier || match.index == null) continue;
    const source = await resolveSource(specifier);
    if (!source) continue;
    const emitted = emittedPath(source);
    if (!(await exists(emitted))) {
      throw new Error(
        `Declaration target for ${specifier} was not emitted: ${emitted}`,
      );
    }
    let relative = path.relative(path.dirname(declaration), emitted);
    relative = relative.replaceAll(path.sep, '/').replace(/\.d\.ts$/u, '.js');
    if (!relative.startsWith('.')) relative = `./${relative}`;
    const specifierOffset = match[0].indexOf(specifier);
    const start = match.index + specifierOffset;
    rewritten += original.slice(cursor, start) + relative;
    cursor = start + specifier.length;
  }
  rewritten += original.slice(cursor);
  if (rewritten !== original) await writeFile(declaration, rewritten);
}
