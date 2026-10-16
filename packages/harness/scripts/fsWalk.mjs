import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

export async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function walkFiles(directory, predicate) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) => !entry.isDirectory() && (!predicate || predicate(entry.name)),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** A static or dynamic import specifier in emitted JavaScript or declarations. */
export const moduleSpecifier =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(?<quote>['"])(?<specifier>[^'"]+)\k<quote>/gu;

const uncommented = ts.createPrinter({ removeComments: true });

/**
 * A declaration file's text without its comments: a published declaration
 * keeps its TSDoc, whose prose (`… from "the store"`) a specifier scan
 * would otherwise read as an import.
 */
export async function readDeclaration(file) {
  return uncommented.printFile(
    ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
    ),
  );
}

/** The declaration files an entry declaration reaches through relative imports. */
export async function reachableDeclarations(entry) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const declaration = pending.pop();
    if (!declaration || visited.has(declaration)) continue;
    visited.add(declaration);
    const source = await readDeclaration(declaration);
    for (const match of source.matchAll(moduleSpecifier)) {
      const specifier = match.groups?.specifier;
      if (!specifier?.startsWith('.')) continue;
      let target = path.resolve(
        path.dirname(declaration),
        specifier.replace(/\.mjs$/u, '.d.mts').replace(/\.js$/u, '.d.ts'),
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
