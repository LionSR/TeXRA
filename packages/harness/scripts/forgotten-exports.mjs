// Forgotten exports: the names a package's published declarations use but no
// entry exports. A consumer meets such a name in a signature and cannot
// import it to annotate a value, implement an interface, or catch an error.
// Walked from each entry's exports through every type reference into the
// package's own declarations; a name a dependency defines is that
// dependency's surface. Held at zero, with no baseline file
// (scripts/ratchet-zero-rules.mjs): any forgotten export fails.
import path from 'node:path';

import ts from 'typescript';

/**
 * `{ name, file }` for each declaration under `distRoot` that a published
 * entry's surface names without exporting; `file` is the declaration's path
 * under `distRoot`. `entries` are the entries' declaration files.
 */
function forgottenExports(distRoot, entries) {
  const program = ts.createProgram(entries, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'],
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const under = (declaration) =>
    path.relative(distRoot, declaration.getSourceFile().fileName);
  const resolve = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;

  const exported = new Set();
  const pending = [];
  for (const entry of entries) {
    const moduleSymbol = checker.getSymbolAtLocation(
      program.getSourceFile(entry),
    );
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      exported.add(resolve(symbol));
      pending.push(resolve(symbol));
    }
  }
  // A name a consumer would write: a type reference, an import type, or an
  // interface's `extends`. A value named in a type position (`typeof
  // Schema`, the `X_base` tsc emits for a class to extend) only spells a
  // type: its shape is walked, its name is not reported.
  const named = new Set();
  const visit = (node) => {
    const name = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : ts.isTypeQueryNode(node)
          ? node.exprName
          : ts.isImportTypeNode(node)
            ? node.qualifier
            : undefined;
    // `ns.Member` names the namespace; its member is the namespace's surface.
    const head = name == null ? undefined : leftmost(name);
    const symbol = head && checker.getSymbolAtLocation(head);
    if (symbol != null) {
      const target = resolve(symbol);
      if (
        ts.isTypeReferenceNode(node) ||
        (ts.isImportTypeNode(node) && !node.isTypeOf) ||
        (ts.isExpressionWithTypeArguments(node) &&
          ts.isInterfaceDeclaration(node.parent.parent))
      ) {
        named.add(target);
      }
      pending.push(target);
    }
    ts.forEachChild(node, visit);
  };
  const visited = new Map();
  while (pending.length > 0) {
    const symbol = pending.pop();
    if (visited.has(symbol) || symbol.flags & ts.SymbolFlags.TypeParameter)
      continue;
    const own = (symbol.declarations ?? []).filter(
      (declaration) => !under(declaration).startsWith('..'),
    );
    visited.set(symbol, own[0]);
    for (const declaration of own) ts.forEachChild(declaration, visit);
  }
  return [...visited]
    .filter(
      ([symbol, declaration]) =>
        declaration != null && named.has(symbol) && !exported.has(symbol),
    )
    .map(([symbol, declaration]) => ({
      name: symbol.name,
      file: under(declaration),
    }));
}

function leftmost(name) {
  if (ts.isIdentifier(name)) return name;
  if (ts.isQualifiedName(name)) return leftmost(name.left);
  if (ts.isPropertyAccessExpression(name)) return leftmost(name.expression);
  return undefined;
}

/**
 * Hold the package's forgotten exports at zero: throws naming each source
 * file (`packages/<name>/src/…ts`) that declares a forgotten name.
 */
export function checkForgottenExports({
  repositoryRoot,
  packageRoot,
  distRoot,
  entries,
}) {
  const sourceRoot = path
    .relative(repositoryRoot, path.join(packageRoot, 'src'))
    .replaceAll('\\', '/');
  const found = new Map();
  for (const { name, file } of forgottenExports(
    path.join(distRoot, 'types'),
    entries,
  )) {
    const source = `${sourceRoot}/${file.replaceAll('\\', '/').replace(/\.d\.ts$/u, '.ts')}`;
    found.set(source, [...(found.get(source) ?? []), name]);
  }
  const problems = [...found].map(
    ([source, names]) =>
      `${source}: ${names.length} forgotten exports: ${names.toSorted().join(', ')}; export each name from an entry, or keep it off the public signatures`,
  );
  if (problems.length > 0) {
    throw new Error(`Forgotten exports:\n  ${problems.join('\n  ')}`);
  }
}
