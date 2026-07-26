// `@shared/schemas` deep-import ratchet (issue #9254). The maintainer ruled
// `@shared/schemas` a published surface, which inverts the anomaly: the barrel
// is no longer what needs justifying, the production statements that reach
// past it into `@shared/schemas/<leaf>` are. Clones the checked-in-baseline +
// AST-scanning vitest pattern from hostAgentDeepImportRatchet.vitest.ts.
//
// The one design requirement: deep imports are recorded in TWO classes, and
// they are gated differently, because they mean opposite things.
//
//   forced     — the statement names at least one symbol the barrel does not
//                re-export. The author had no barrel path to use, so this is a
//                report that a leaf module is missing from the published
//                surface, NOT a contributor error. Gated only on the SET of
//                off-surface specifiers: another statement against an
//                already-off-surface module passes; pushing a *new* module off
//                the surface fails.
//   gratuitous — every name is reachable through `@shared/schemas`. The barrel
//                was simply not used. Gated hard, per specifier, on count.
//
// Collapsing the two into one number would peg the total at the forced floor
// forever, which reads as a broken ratchet (cf. #8900) and gets it deleted.
//
// Regenerate after an intentional change:
//   TEXRA_UPDATE_SHARED_SCHEMAS_BASELINE=1 npx vitest run \
//     src/test-kernel/architecture/sharedSchemasDeepImportRatchet

// Node imports
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceFilesUnder, toRepoPath } from '../support/repoScan';

const BASELINE_FILE =
  'config/ratchets/shared-schemas-deep-import-baseline.json';
const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_FILE);

const BARREL_PATH = resolve(REPO_ROOT, 'src/shared/schemas/index.ts');
/** The surface's own interior — a sibling import there cannot use the barrel. */
const SURFACE_INTERIOR = 'src/shared/schemas/';
const DEEP_IMPORT_PREFIX = '@shared/schemas/';

const SCAN_ROOTS = [
  'src',
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'packages/trace-viewer/src',
];

const SEMANTICS =
  "Production statements that reach past the published '@shared/schemas' " +
  'barrel into a leaf module, keyed by specifier, valued by the importing ' +
  "file ('(type-only)' marks an `import type` statement, so a file that " +
  'splits its value and type imports contributes two distinct entries). ' +
  "'forced' statements name at least one symbol the barrel does not " +
  're-export: they are a report that a leaf module is missing from the ' +
  'published surface, and only a NEW off-surface specifier fails the ratchet. ' +
  "'gratuitous' statements could have used the barrel verbatim; their per-" +
  'specifier count may not grow. Classification is computed against ' +
  'src/shared/schemas/index.ts at test time, so widening the barrel ' +
  'reclassifies statements automatically (and requires regenerating this ' +
  'file in the same PR). Scan excludes src/test-kernel/ and the surface ' +
  'interior src/shared/schemas/.';

type DeepImports = Record<string, string[]>;

interface SchemasBaseline {
  semantics: string;
  forced: DeepImports;
  gratuitous: DeepImports;
}

function parseSourceFile(
  file: string,
  text = readFileSync(file, 'utf8'),
): ts.SourceFile {
  // No parent pointers: nothing here walks upward, and setting them roughly
  // doubles the parse cost across ~2k files.
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function resolveRelative(
  fromFile: string,
  specifier: string,
): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
    (candidate) => existsSync(candidate),
  );
}

/** Every name `import { … } from '@shared/schemas'` can resolve, `export *` followed. */
function barrelExportedNames(
  file: string,
  seen = new Set<string>(),
): Set<string> {
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);
  for (const statement of parseSourceFile(file).statements) {
    if (ts.isExportDeclaration(statement)) {
      const { exportClause, moduleSpecifier } = statement;
      if (exportClause != null && ts.isNamedExports(exportClause)) {
        for (const element of exportClause.elements)
          names.add(element.name.text);
      } else if (exportClause != null && ts.isNamespaceExport(exportClause)) {
        names.add(exportClause.name.text);
      } else if (
        exportClause == null &&
        moduleSpecifier != null &&
        ts.isStringLiteralLike(moduleSpecifier)
      ) {
        const target = resolveRelative(file, moduleSpecifier.text);
        if (target == null)
          throw new Error(
            `Unresolved re-export ${moduleSpecifier.text} in ${file}`,
          );
        for (const name of barrelExportedNames(target, seen)) names.add(name);
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    if (
      !modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    )
      continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name != null
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/**
 * The names a statement pulls from the leaf, or `undefined` for the forms that
 * take the module wholesale (namespace, default, side-effect, `export *`) and
 * so can never be shown barrel-reachable.
 */
function importedNames(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): string[] | undefined {
  const clause = ts.isImportDeclaration(node)
    ? node.importClause
    : node.exportClause;
  if (clause == null) return undefined;
  if (ts.isImportClause(clause)) {
    if (clause.name != null || clause.namedBindings == null) return undefined;
    if (!ts.isNamedImports(clause.namedBindings)) return undefined;
    return clause.namedBindings.elements.map(
      (element) => (element.propertyName ?? element.name).text,
    );
  }
  if (!ts.isNamedExports(clause)) return undefined;
  return clause.elements.map(
    (element) => (element.propertyName ?? element.name).text,
  );
}

function collectCurrent(): Pick<SchemasBaseline, 'forced' | 'gratuitous'> {
  const surface = barrelExportedNames(BARREL_PATH);
  const forced: DeepImports = {};
  const gratuitous: DeepImports = {};

  for (const root of SCAN_ROOTS) {
    for (const file of sourceFilesUnder(resolve(REPO_ROOT, root), {
      excludeTestKernel: true,
      missingDirReturnsEmpty: true,
    })) {
      const repoPath = toRepoPath(file);
      if (repoPath.startsWith(SURFACE_INTERIOR)) continue;
      // Cheap text gate before the parser: only ~300 of ~2k files can match,
      // and parsing the rest is what makes this ratchet slow enough to starve
      // its sibling suites of CPU when vitest runs them in parallel.
      const text = readFileSync(file, 'utf8');
      if (!text.includes(DEEP_IMPORT_PREFIX)) continue;
      // Import and `export … from` declarations are only ever top-level, so
      // the statement list is the whole search space.
      for (const node of parseSourceFile(file, text).statements) {
        if (
          !(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
          node.moduleSpecifier == null ||
          !ts.isStringLiteralLike(node.moduleSpecifier) ||
          !node.moduleSpecifier.text.startsWith(DEEP_IMPORT_PREFIX)
        ) {
          continue;
        }
        const names = importedNames(node);
        const bucket =
          names?.every((name) => surface.has(name)) === true
            ? gratuitous
            : forced;
        const typeOnly = ts.isImportDeclaration(node)
          ? (node.importClause?.isTypeOnly ?? false)
          : node.isTypeOnly;
        (bucket[node.moduleSpecifier.text] ??= []).push(
          typeOnly ? `${repoPath} (type-only)` : repoPath,
        );
      }
    }
  }
  const sorted = (imports: DeepImports): DeepImports =>
    Object.fromEntries(
      Object.entries(imports)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([specifier, entries]) => [
          specifier,
          entries.toSorted((a, b) => a.localeCompare(b)),
        ]),
    );
  return { forced: sorted(forced), gratuitous: sorted(gratuitous) };
}

function total(imports: DeepImports): number {
  return Object.values(imports).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
}

describe('@shared/schemas deep-import ratchet', () => {
  // One scan for the whole suite; every case reads the same snapshot.
  const current = collectCurrent();
  if (process.env.TEXRA_UPDATE_SHARED_SCHEMAS_BASELINE === '1') {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ semantics: SEMANTICS, ...current }, null, 2)}\n`,
    );
  }
  const baseline = JSON.parse(
    readFileSync(BASELINE_PATH, 'utf8'),
  ) as SchemasBaseline;

  it('does not add gratuitous @shared/schemas deep imports', () => {
    const specifiers = [
      ...new Set([
        ...Object.keys(baseline.gratuitous),
        ...Object.keys(current.gratuitous),
      ]),
    ].toSorted((a, b) => a.localeCompare(b));
    const grown = specifiers.filter(
      (specifier) =>
        (current.gratuitous[specifier]?.length ?? 0) >
        (baseline.gratuitous[specifier]?.length ?? 0),
    );
    const report = grown
      .map((specifier) => {
        const allowed = new Set(baseline.gratuitous[specifier] ?? []);
        const added = (current.gratuitous[specifier] ?? []).filter(
          (entry) => !allowed.has(entry),
        );
        return `  ${specifier}: ${allowed.size} -> ${current.gratuitous[specifier]?.length ?? 0}\n${added
          .map((entry) => `    + ${entry}`)
          .join('\n')}`;
      })
      .join('\n');
    expect(
      grown,
      `Every name in these statements is already exported by '@shared/schemas'; import the barrel instead.\n${report}\n\n` +
        `If the growth is intentional (e.g. the barrel was widened, reclassifying forced statements), regenerate ${BASELINE_FILE} in this PR.`,
    ).toEqual([]);
  });

  it('does not push a new module off the published @shared/schemas surface', () => {
    // A forced statement against an already-off-surface module is allowed: the
    // author has no barrel path. A NEW off-surface specifier is a widening of
    // the gap and needs the surface-membership decision, not a silent baseline.
    const newlyForced = Object.keys(current.forced)
      .filter((specifier) => !(specifier in baseline.forced))
      .toSorted((a, b) => a.localeCompare(b));
    expect(
      newlyForced,
      `These statements name symbols '@shared/schemas' does not re-export, from modules that were not previously off-surface:\n` +
        newlyForced.map((specifier) => `  + ${specifier}`).join('\n') +
        `\n\nEither import a symbol the barrel publishes, or land the surface-membership decision and regenerate ${BASELINE_FILE}.`,
    ).toEqual([]);
  });

  it('keeps forced and gratuitous separate, sorted, and duplicate-free', () => {
    // Separation is the point of this ratchet: a combined count could never
    // fall below the forced floor and would be read as permanently stuck.
    expect(Object.keys(baseline)).toEqual([
      'semantics',
      'forced',
      'gratuitous',
    ]);
    for (const key of ['forced', 'gratuitous'] as const) {
      for (const [specifier, entries] of Object.entries(baseline[key])) {
        // Sorted AND distinct: a duplicated entry would inflate the allowed
        // count and silently weaken the ratchet.
        expect(entries, `${BASELINE_FILE} ${key}["${specifier}"]`).toEqual(
          [...new Set(entries)].toSorted((a, b) => a.localeCompare(b)),
        );
      }
    }
    expect(total(baseline.forced) + total(baseline.gratuitous)).toBeGreaterThan(
      0,
    );
  });
});
