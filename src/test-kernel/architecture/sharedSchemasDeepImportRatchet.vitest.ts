// `@shared/schemas` deep-import ratchet (issue #9254). The maintainer ruled
// `@shared/schemas` a published surface, which inverts the anomaly: the barrel
// is no longer what needs justifying, the production statements that reach
// past it into `@shared/schemas/<leaf>` are. Clones the checked-in-baseline +
// AST-scanning vitest pattern from hostAgentDeepImportRatchet.vitest.ts.
//
// The one design requirement: deep imports are recorded in TWO classes, and
// they are gated differently, because they mean opposite things.
//
//   forced     — either the statement names a symbol the barrel does not
//                re-export, or the exact statement is a documented layering
//                floor that cannot use the barrel without creating a cycle.
//                New off-surface modules and new floor entries fail.
//   gratuitous — every name is reachable through `@shared/schemas`, with no
//                documented layering constraint. Any new statement fails.
//
// Collapsing the two into one number would peg the total at the forced floor
// forever, which reads as a broken ratchet (cf. #8900) and gets it deleted.
//
// Regenerate after an intentional change:
//   TEXRA_UPDATE_SHARED_SCHEMAS_BASELINE=1 npx vitest run \
//     src/test-kernel/architecture/sharedSchemasDeepImportRatchet

// Node imports
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

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

const SEMANTICS =
  "Production and test-kernel statements that reach past the published '@shared/schemas' " +
  'barrel into a leaf module, keyed by specifier, valued by the importing ' +
  "file ('(type-only)' marks an `import type` statement, so a file that " +
  'splits its value and type imports contributes two distinct entries). ' +
  "'forced' statements either name a symbol the barrel does not re-export, " +
  'or are exact documented layering-floor entries that cannot use the barrel ' +
  'without creating a cycle. A new off-surface specifier or layering-floor ' +
  "entry fails the ratchet. 'gratuitous' statements could use the barrel " +
  'verbatim and have no documented layering constraint; any new entry fails. ' +
  'Classification is computed against ' +
  'src/shared/schemas/index.ts at test time, so widening the barrel ' +
  'reclassifies statements automatically (and requires regenerating this ' +
  'file in the same PR). The leaf-aware published-surface snapshot preserves ' +
  'the exact type/value bindings used by published deep imports, so those ' +
  'bindings may not contract even if their importers move. Scan covers ' +
  'repo-root src/ and every packages/*/src directory, excluding only the ' +
  'surface interior src/shared/schemas/ (test-kernel files are ratcheted ' +
  'like production).';

type DeepImports = Record<string, string[]>;
type ExportSpace = 'type' | 'value';

interface PublishedLeafSurface {
  type: string[];
  value: string[];
}

type PublishedSurface = Record<string, PublishedLeafSurface>;

interface SchemasBaseline {
  semantics: string;
  surface: PublishedSurface;
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

interface ImportBinding {
  name: string;
  requestedSpace: ExportSpace | 'ordinary';
}

/**
 * The bindings a statement pulls from the leaf, or `undefined` for forms that
 * take the module wholesale and therefore cannot use the barrel verbatim.
 */
function importedBindings(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): ImportBinding[] | undefined {
  const clause = ts.isImportDeclaration(node)
    ? node.importClause
    : node.exportClause;
  if (clause == null) return undefined;
  if (ts.isImportClause(clause)) {
    if (clause.name != null) {
      return [
        {
          name: 'default',
          requestedSpace: clause.isTypeOnly ? 'type' : 'ordinary',
        },
      ];
    }
    if (clause.namedBindings == null) return undefined;
    if (!ts.isNamedImports(clause.namedBindings)) return undefined;
    return clause.namedBindings.elements.map((element) => ({
      name: (element.propertyName ?? element.name).text,
      requestedSpace:
        clause.isTypeOnly || element.isTypeOnly
          ? ('type' as const)
          : ('ordinary' as const),
    }));
  }
  if (!ts.isNamedExports(clause)) return undefined;
  return clause.elements.map((element) => ({
    name: (element.propertyName ?? element.name).text,
    requestedSpace:
      (ts.isExportDeclaration(node) && node.isTypeOnly) || element.isTypeOnly
        ? ('type' as const)
        : ('ordinary' as const),
  }));
}

interface DeepImportReference {
  bindings: ImportBinding[] | undefined;
  specifier: string;
  typeOnly: boolean;
}

function importTypeSpecifier(node: ts.ImportTypeNode): string | undefined {
  return ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
    ? node.argument.literal.text
    : undefined;
}

function firstQualifiedName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : firstQualifiedName(name.left);
}

/**
 * `import(…)`, `require(…)`, `module.require(…)`, `require.resolve(…)` or
 * `import.meta.resolve(…)`.
 */
function isModuleLoadingCallee(expression: ts.LeftHandSideExpression): boolean {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(expression)) return expression.text === 'require';
  if (!ts.isPropertyAccessExpression(expression)) return false;

  const { expression: target, name } = expression;
  if (ts.isIdentifier(target)) {
    return (
      (target.text === 'module' && name.text === 'require') ||
      (target.text === 'require' && name.text === 'resolve')
    );
  }
  return (
    ts.isMetaProperty(target) &&
    target.keywordToken === ts.SyntaxKind.ImportKeyword &&
    name.text === 'resolve'
  );
}

/** Find every syntactic form that can reach into a schema leaf. */
function deepImportReferences(
  sourceFile: ts.SourceFile,
): DeepImportReference[] {
  const references: DeepImportReference[] = [];
  const add = (
    specifier: string | undefined,
    bindings: ImportBinding[] | undefined,
    typeOnly: boolean,
  ): void => {
    if (specifier?.startsWith(DEEP_IMPORT_PREFIX) !== true) return;
    references.push({ bindings, specifier, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const bindings = importedBindings(node);
      add(
        node.moduleSpecifier != null &&
          ts.isStringLiteralLike(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined,
        bindings,
        bindings?.every(({ requestedSpace }) => requestedSpace === 'type') ??
          (ts.isImportDeclaration(node)
            ? (node.importClause?.isTypeOnly ?? false)
            : node.isTypeOnly),
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      add(
        expression != null && ts.isStringLiteralLike(expression)
          ? expression.text
          : undefined,
        undefined,
        node.isTypeOnly,
      );
    } else if (ts.isImportTypeNode(node)) {
      add(
        importTypeSpecifier(node),
        node.qualifier == null
          ? undefined
          : [
              {
                name: firstQualifiedName(node.qualifier),
                requestedSpace: 'type',
              },
            ],
        true,
      );
    } else if (
      ts.isCallExpression(node) &&
      isModuleLoadingCallee(node.expression)
    ) {
      const [argument] = node.arguments;
      add(
        argument != null && ts.isStringLiteralLike(argument)
          ? argument.text
          : undefined,
        undefined,
        false,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

interface ModuleExport {
  readonly sources: Set<string>;
  readonly spaces: Set<ExportSpace>;
}

type ModuleExports = Map<string, ModuleExport>;

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts
      .getModifiers(node)
      ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function addModuleExport(
  exports: ModuleExports,
  name: string,
  spaces: Iterable<ExportSpace>,
  sources: Iterable<string>,
): void {
  const entry = exports.get(name) ?? {
    sources: new Set<string>(),
    spaces: new Set<ExportSpace>(),
  };
  for (const space of spaces) entry.spaces.add(space);
  for (const source of sources) entry.sources.add(source);
  exports.set(name, entry);
}

function declarationSpaces(node: ts.Node): readonly ExportSpace[] | undefined {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return ['type'];
  }
  if (
    ts.isVariableStatement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    // A value export can also be imported with `import type` and referenced
    // through `typeof`; only an `export type` loses the value namespace.
    return ['type', 'value'];
  }
  return undefined;
}

function constrainedSpaces(
  spaces: ReadonlySet<ExportSpace>,
  typeOnly: boolean,
): readonly ExportSpace[] {
  if (!typeOnly) return [...spaces];
  return spaces.size === 0 ? [] : ['type'];
}

/**
 * Public names of one schema module, together with every same-name re-export
 * path by which the root barrel can expose that exact leaf.
 */
function schemaModuleExports(
  file: string,
  memo = new Map<string, ModuleExports>(),
  active = new Set<string>(),
): ModuleExports {
  const cached = memo.get(file);
  if (cached) return cached;
  if (active.has(file)) {
    throw new Error(`Cyclic schema re-export graph at ${toRepoPath(file)}`);
  }
  active.add(file);
  const exports: ModuleExports = new Map();
  const sourceFile = parseSourceFile(file);

  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement)) continue;
    const spaces = declarationSpaces(statement);
    if (spaces == null) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          addModuleExport(exports, declaration.name.text, spaces, [file]);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name != null &&
      ts.isIdentifier(statement.name)
    ) {
      addModuleExport(exports, statement.name.text, spaces, [file]);
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const { exportClause, moduleSpecifier } = statement;
    const specifier =
      moduleSpecifier != null && ts.isStringLiteralLike(moduleSpecifier)
        ? moduleSpecifier.text
        : undefined;
    const target =
      specifier?.startsWith('.') === true
        ? resolveRelative(file, specifier)
        : undefined;
    if (specifier?.startsWith('.') === true && target == null) {
      throw new Error(
        `Unresolved re-export ${specifier} in ${toRepoPath(file)}`,
      );
    }
    const targetExports =
      target == null ? undefined : schemaModuleExports(target, memo, active);

    if (exportClause == null) {
      if (targetExports == null) continue;
      for (const [name, entry] of targetExports) {
        addModuleExport(
          exports,
          name,
          constrainedSpaces(entry.spaces, statement.isTypeOnly),
          [...entry.sources, file],
        );
      }
      continue;
    }

    if (ts.isNamespaceExport(exportClause)) {
      addModuleExport(
        exports,
        exportClause.name.text,
        statement.isTypeOnly ? ['type'] : ['type', 'value'],
        [file],
      );
      continue;
    }

    for (const element of exportClause.elements) {
      const sourceName = (element.propertyName ?? element.name).text;
      const publicName = element.name.text;
      const typeOnly = statement.isTypeOnly || element.isTypeOnly;
      const targetEntry = targetExports?.get(sourceName);
      const externalSpaces = typeOnly
        ? (['type'] as const)
        : (['type', 'value'] as const);
      const spaces =
        targetEntry == null
          ? externalSpaces
          : constrainedSpaces(targetEntry.spaces, typeOnly);
      const sources =
        targetEntry != null && sourceName === publicName
          ? [...targetEntry.sources, file]
          : [file];
      addModuleExport(exports, publicName, spaces, sources);
    }
  }

  active.delete(file);
  memo.set(file, exports);
  return exports;
}

function schemaSpecifier(file: string): string | undefined {
  const schemasRoot = resolve(REPO_ROOT, SURFACE_INTERIOR);
  const leaf = relative(schemasRoot, file)
    .replaceAll('\\', '/')
    .replace(/\.(?:ts|tsx)$/, '')
    .replace(/\/index$/, '');
  if (leaf.startsWith('../') || leaf === 'index') return undefined;
  return `${DEEP_IMPORT_PREFIX}${leaf}`;
}

type MutablePublishedSurface = Map<
  string,
  { type: Set<string>; value: Set<string> }
>;

function addPublishedBinding(
  surface: MutablePublishedSurface,
  specifier: string,
  name: string,
  space: ExportSpace,
): void {
  const leaf = surface.get(specifier) ?? {
    type: new Set<string>(),
    value: new Set<string>(),
  };
  leaf[space].add(name);
  surface.set(specifier, leaf);
}

function sortPublishedSurface(
  surface: MutablePublishedSurface,
): PublishedSurface {
  return Object.fromEntries(
    [...surface]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([specifier, spaces]) => [
        specifier,
        {
          type: [...spaces.type].toSorted((a, b) => a.localeCompare(b)),
          value: [...spaces.value].toSorted((a, b) => a.localeCompare(b)),
        },
      ]),
  );
}

function publishedSurface(
  moduleMemo = new Map<string, ModuleExports>(),
): PublishedSurface {
  const surface: MutablePublishedSurface = new Map();
  for (const [name, entry] of schemaModuleExports(BARREL_PATH, moduleMemo)) {
    for (const source of entry.sources) {
      const specifier = schemaSpecifier(source);
      if (specifier == null) continue;
      for (const space of entry.spaces) {
        addPublishedBinding(surface, specifier, name, space);
      }
    }
  }
  return sortPublishedSurface(surface);
}

function scanRoots(): string[] {
  const packagesRoot = resolve(REPO_ROOT, 'packages');
  return [
    'src',
    ...readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/src`)
      .toSorted((a, b) => a.localeCompare(b)),
  ];
}

function reachableSpace(
  surface: PublishedSurface,
  specifier: string,
  binding: ImportBinding,
  moduleMemo: Map<string, ModuleExports>,
): ExportSpace | undefined {
  const published = surface[specifier];
  if (binding.requestedSpace === 'type') {
    return published?.type.includes(binding.name) === true ? 'type' : undefined;
  }
  if (published?.value.includes(binding.name) === true) return 'value';
  if (published?.type.includes(binding.name) !== true) return undefined;

  const leaf = specifier.slice(DEEP_IMPORT_PREFIX.length);
  const file = resolveRelative(BARREL_PATH, `./${leaf}`);
  if (file == null) return undefined;
  const leafExport = schemaModuleExports(file, moduleMemo).get(binding.name);
  return leafExport != null && !leafExport.spaces.has('value')
    ? 'type'
    : undefined;
}

function isLeafFullyPublished(
  surface: PublishedSurface,
  specifier: string,
  moduleMemo: Map<string, ModuleExports>,
  typeOnly = false,
): boolean {
  const leaf = specifier.slice(DEEP_IMPORT_PREFIX.length);
  const file = resolveRelative(BARREL_PATH, `./${leaf}`);
  if (file == null) return false;
  const leafExports = schemaModuleExports(file, moduleMemo);
  if (leafExports.size === 0) return false;
  const published = surface[specifier];
  const required = [...leafExports].flatMap(([name, entry]) =>
    [...entry.spaces]
      .filter((space) => !typeOnly || space === 'type')
      .map((space) => ({ name, space })),
  );
  return (
    required.length > 0 &&
    required.every(
      ({ name, space }) => published?.[space].includes(name) === true,
    )
  );
}

function collectCurrent(
  documentedForced: DeepImports = {},
): Pick<SchemasBaseline, 'surface' | 'forced' | 'gratuitous'> {
  const moduleMemo = new Map<string, ModuleExports>();
  const fullSurface = publishedSurface(moduleMemo);
  const referencedSurface: MutablePublishedSurface = new Map();
  const forced: DeepImports = {};
  const gratuitous: DeepImports = {};

  for (const root of scanRoots()) {
    for (const file of sourceFilesUnder(resolve(REPO_ROOT, root), {
      excludeTestKernel: false,
      missingDirReturnsEmpty: true,
    })) {
      const repoPath = toRepoPath(file);
      if (repoPath.startsWith(SURFACE_INTERIOR)) continue;
      // Cheap text gate before the parser: only ~300 of ~2k files can match,
      // and parsing the rest is what makes this ratchet slow enough to starve
      // its sibling suites of CPU when vitest runs them in parallel.
      const text = readFileSync(file, 'utf8');
      if (!text.includes(DEEP_IMPORT_PREFIX)) continue;
      for (const reference of deepImportReferences(
        parseSourceFile(file, text),
      )) {
        const resolvedSpaces = reference.bindings?.map((binding) =>
          reachableSpace(fullSurface, reference.specifier, binding, moduleMemo),
        );
        const isPublished =
          reference.bindings == null
            ? isLeafFullyPublished(
                fullSurface,
                reference.specifier,
                moduleMemo,
                reference.typeOnly,
              )
            : resolvedSpaces?.every((space) => space != null) === true;
        const entry = reference.typeOnly ? `${repoPath} (type-only)` : repoPath;
        const isDocumentedFloor =
          isPublished &&
          documentedForced[reference.specifier]?.includes(entry) === true;
        const bucket = isPublished && !isDocumentedFloor ? gratuitous : forced;
        if (isPublished) {
          if (reference.bindings == null) {
            const published = fullSurface[reference.specifier];
            for (const space of ['type', 'value'] as const) {
              if (reference.typeOnly && space === 'value') continue;
              for (const name of published?.[space] ?? []) {
                addPublishedBinding(
                  referencedSurface,
                  reference.specifier,
                  name,
                  space,
                );
              }
            }
          } else {
            for (const [index, binding] of reference.bindings.entries()) {
              const space = resolvedSpaces?.[index];
              if (space == null) continue;
              addPublishedBinding(
                referencedSurface,
                reference.specifier,
                binding.name,
                space,
              );
            }
          }
        }
        (bucket[reference.specifier] ??= []).push(entry);
      }
    }
  }
  const sorted = (imports: DeepImports): DeepImports =>
    Object.fromEntries(
      Object.entries(imports)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([specifier, entries]) => [
          specifier,
          [...new Set(entries)].toSorted((a, b) => a.localeCompare(b)),
        ]),
    );
  return {
    surface: sortPublishedSurface(referencedSurface),
    forced: sorted(forced),
    gratuitous: sorted(gratuitous),
  };
}

function total(imports: DeepImports): number {
  return Object.values(imports).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
}

function contractedSurface(
  baseline: SchemasBaseline,
  current: PublishedSurface,
): string[] {
  return Object.entries(baseline.surface).flatMap(([specifier, spaces]) =>
    (['type', 'value'] as const).flatMap((space) => {
      const currentNames = new Set(current[specifier]?.[space] ?? []);
      return spaces[space]
        .filter((name) => !currentNames.has(name))
        .map((name) => `${specifier} [${space}]: ${name}`);
    }),
  );
}

describe('@shared/schemas deep-import ratchet', () => {
  it('finds every TypeScript module-loading form', () => {
    const source = parseSourceFile(
      'probe.ts',
      `
        import { AgentCategory } from '@shared/schemas/agent';
        export { AgentCategory } from '@shared/schemas/agent';
        import defaultAgent from '@shared/schemas/agent';
        import * as agentNamespace from '@shared/schemas/agent';
        import type * as agentTypes from '@shared/schemas/agent';
        export type * from '@shared/schemas/agent';
        export type * as agentExportTypes from '@shared/schemas/agent';
        import agent = require('@shared/schemas/agent');
        const dynamic = import('@shared/schemas/agent');
        const commonJs = require('@shared/schemas/agent');
        const moduleCommonJs = module.require('@shared/schemas/agent');
        const requirePath = require.resolve('@shared/schemas/agent');
        const importPath = import.meta.resolve('@shared/schemas/agent');
        type Category = import('@shared/schemas/agent').AgentCategory;
      `,
    );

    const specifier = '@shared/schemas/agent';
    const named = (
      requestedSpace: 'ordinary' | 'type',
    ): DeepImportReference => ({
      bindings: [{ name: 'AgentCategory', requestedSpace }],
      specifier,
      typeOnly: requestedSpace === 'type',
    });
    // Forms that take the module wholesale report no bindings.
    const wholesale = (typeOnly: boolean): DeepImportReference => ({
      bindings: undefined,
      specifier,
      typeOnly,
    });

    expect(deepImportReferences(source)).toEqual([
      named('ordinary'), // import { AgentCategory }
      named('ordinary'), // export { AgentCategory }
      {
        bindings: [{ name: 'default', requestedSpace: 'ordinary' }],
        specifier,
        typeOnly: false,
      },
      wholesale(false), // import * as agentNamespace
      wholesale(true), // import type * as agentTypes
      wholesale(true), // export type *
      wholesale(true), // export type * as agentExportTypes
      wholesale(false), // import agent = require(…)
      wholesale(false), // import(…)
      wholesale(false), // require(…)
      wholesale(false), // module.require(…)
      wholesale(false), // require.resolve(…)
      wholesale(false), // import.meta.resolve(…)
      named('type'), // import('…').AgentCategory
    ]);
  });

  it('detects leaf-local type/value surface contraction independently of importers', () => {
    const specifier = '@shared/schemas/profileViewMessages';
    const fixtureBaseline: SchemasBaseline = {
      semantics: '',
      surface: {
        [specifier]: {
          type: ['NumberSetting', 'RuntimeSchema'],
          value: ['RuntimeSchema'],
        },
      },
      forced: { [specifier]: ['src/already-forced.ts'] },
      gratuitous: { [specifier]: ['src/old.ts'] },
    };
    const fixtureCurrent: PublishedSurface = {
      [specifier]: {
        type: ['NumberSetting', 'RuntimeSchema'],
        value: [],
      },
    };

    expect(contractedSurface(fixtureBaseline, fixtureCurrent)).toEqual([
      `${specifier} [value]: RuntimeSchema`,
    ]);
  });

  it('tracks published names by their exact leaf and export namespace', () => {
    const moduleMemo = new Map<string, ModuleExports>();
    const surface = publishedSurface(moduleMemo);

    expect(surface['@shared/schemas/profileViewMessages']?.type).toContain(
      'NumberSetting',
    );
    expect(surface['@shared/schemas/profileViewMessages']?.value).not.toContain(
      'NumberSetting',
    );
    expect(surface['@shared/schemas/settingsViewMessages']?.type).toContain(
      'NumberSetting',
    );
    expect(surface['@shared/schemas/commonViewMessages']?.type).not.toContain(
      'NumberSetting',
    );
    expect(surface['@shared/schemas/commonViewMessages']?.value).not.toContain(
      'ThemeSchema',
    );
    expect(surface['@shared/schemas/commonViewMessages']?.value).not.toContain(
      'Theme',
    );
    expect(
      isLeafFullyPublished(surface, '@shared/schemas/agent', moduleMemo),
    ).toBe(true);
    expect(
      isLeafFullyPublished(
        surface,
        '@shared/schemas/profileViewMessages',
        moduleMemo,
      ),
    ).toBe(false);
    expect(
      reachableSpace(
        surface,
        '@shared/schemas/profileViewMessages',
        {
          name: 'NumberSetting',
          requestedSpace: 'ordinary',
        },
        moduleMemo,
      ),
    ).toBe('type');
    expect(
      reachableSpace(
        surface,
        '@shared/schemas/profileViewMessages',
        {
          name: 'API_ACCESS_MODE_OPTIONS',
          requestedSpace: 'ordinary',
        },
        moduleMemo,
      ),
    ).toBe('value');
  });

  const baseline = JSON.parse(
    readFileSync(BASELINE_PATH, 'utf8'),
  ) as SchemasBaseline;
  // One scan for the whole suite; every case reads the same snapshot. Exact
  // published entries in `forced` are documented layering floors.
  const current = collectCurrent(baseline.forced);
  if (process.env.TEXRA_UPDATE_SHARED_SCHEMAS_BASELINE === '1') {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ semantics: SEMANTICS, ...current }, null, 2)}\n`,
    );
  }

  it('does not add gratuitous @shared/schemas deep imports', () => {
    const added = Object.entries(current.gratuitous).flatMap(
      ([specifier, entries]) => {
        const allowed = new Set(baseline.gratuitous[specifier] ?? []);
        return entries
          .filter((entry) => !allowed.has(entry))
          .map((entry) => `${specifier}: ${entry}`);
      },
    );
    expect(
      added,
      `Every name in these statements is already exported by '@shared/schemas'; import the barrel instead.\n` +
        added.map((entry) => `  + ${entry}`).join('\n') +
        `\n\nIf the growth is intentional (e.g. the barrel was widened, reclassifying forced statements), regenerate ${BASELINE_FILE} in this PR.`,
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

  it('does not shrink the leaf-aware published surface', () => {
    const contracted = contractedSurface(baseline, publishedSurface());
    expect(
      contracted,
      `These leaf symbols were previously reachable through '@shared/schemas', but are no longer exported in the same namespace:\n` +
        contracted.map((entry) => `  ${entry}`).join('\n') +
        `\n\nRestore the published symbols, or land the surface-membership decision and regenerate ${BASELINE_FILE}.`,
    ).toEqual([]);
  });

  it('keeps forced and gratuitous separate, sorted, and duplicate-free', () => {
    // Separation is the point of this ratchet: a combined count could never
    // fall below the forced floor and would be read as permanently stuck.
    expect(Object.keys(baseline)).toEqual([
      'semantics',
      'surface',
      'forced',
      'gratuitous',
    ]);
    for (const [specifier, spaces] of Object.entries(baseline.surface)) {
      for (const space of ['type', 'value'] as const) {
        expect(
          spaces[space],
          `${BASELINE_FILE} surface["${specifier}"].${space}`,
        ).toEqual(
          [...new Set(spaces[space])].toSorted((a, b) => a.localeCompare(b)),
        );
      }
    }
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
