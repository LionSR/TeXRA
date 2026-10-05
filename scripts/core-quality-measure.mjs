// Measures the core-quality rules over CORE_QUALITY_DIRS (eslint.config.mjs).
// Each rule yields its sites per file; check-core-quality.mjs compares the
// per-file counts with config/ratchets/core-quality/<rule>.json.
//
// The ESLint half runs ESLint's own rules without type information, so it
// is fast and needs no project. The AST half reads each file with the
// TypeScript parser. Import cycles come from esbuild's metafile: esbuild
// erases type-only imports and resolves the tsconfig aliases, so its graph
// is exactly the runtime module graph.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';
import { ESLint } from 'eslint';
import ts from 'typescript';
import tseslint from 'typescript-eslint';
import { parse as parseYaml } from 'yaml';

import { CORE_QUALITY_DIRS, EFFECT_RUN_ENTRIES } from '../eslint.config.mjs';
import { coreEntries } from './core-quality-api-report.mjs';
import { walkFiles } from './walkFiles.mjs';

/** Lines a core file may hold before it needs a budget row. */
const CORE_FILE_LINES = 400;

/**
 * The ESLint-measured rules: baseline name, rule id and options. Thresholds
 * are the core-quality study's (texra-design-pages/core-quality-study.md
 * §14, taken 2026-10-03): physical function length 150 with IIFEs counted,
 * so a layer closure used as a module counts; modified cyclomatic
 * complexity 15, so a `switch` over an owned union counts once.
 */
const ESLINT_RULES = [
  ['no-explicit-any', '@typescript-eslint/no-explicit-any', []],
  ['no-non-null-assertion', '@typescript-eslint/no-non-null-assertion', []],
  [
    'explicit-module-boundary-types',
    '@typescript-eslint/explicit-module-boundary-types',
    [],
  ],
  [
    'consistent-type-assertions',
    '@typescript-eslint/consistent-type-assertions',
    [{ assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }],
  ],
  ['complexity', 'complexity', [{ max: 15, variant: 'modified' }]],
  ['max-depth', 'max-depth', [4]],
  [
    'max-lines-per-function',
    'max-lines-per-function',
    [{ max: 150, skipBlankLines: false, skipComments: false, IIFEs: true }],
  ],
];

/** Every rule, in report order, with the one line the report prints. */
export const RULES = {
  'no-explicit-any': '`any` disables the checker for everything it touches.',
  'no-non-null-assertion':
    '`!` asserts a fact the types do not hold; model it so the value cannot be absent.',
  'type-assertions':
    '`as` (other than `as const`) without a `// cast:` reason on its line or the line before overrides the checker; a schema decode or a narrower type removes it.',
  'consistent-type-assertions':
    'An object literal asserted to a type, or a `<T>x` assertion: annotate the binding instead.',
  'explicit-module-boundary-types':
    'An exported function states its contract instead of leaking an inferred one.',
  'undocumented-exports':
    'Every exported declaration carries a TSDoc comment saying what it is for.',
  'import-cycles':
    'Runtime import edges inside a cycle; a cycle means two modules share one owner.',
  'file-size': `A core file over ${CORE_FILE_LINES} lines holds more than one responsibility.`,
  complexity:
    'Functions over modified cyclomatic complexity 15: special cases a better data shape would remove.',
  'max-depth':
    'Blocks nested deeper than 4: control flow standing in for a data structure.',
  'max-lines-per-function':
    'Functions over 150 lines (layer closures included): shared locals hiding the state each helper depends on; make that state an explicit value.',
  'new-promise':
    '`new Promise` in core: Effect owns async (Effect.async/callback at a foreign edge).',
  'promise-then': '`.then(` chains in core: compose with Effect instead.',
  'effect-run':
    '`Effect.run*` in core outside a named runtime entry: the run belongs to the host that owns the runtime.',
  'try-catch-effect':
    '`try/catch` around Effect code: errors belong in the typed error channel.',
  'silent-degradation':
    'Empty `catch {}`, `.catch(() => value)`, `Effect.orElseSucceed`, and `Effect.ignore` without a log: a failure turned into a quiet default.',
  'missing-readme':
    'A core directory without a README holding a purpose line and a mermaid diagram.',
  'entry-files':
    'Repo files a core package entry evaluates on import (value imports only): a stray import drags the app in.',
  'entry-externals':
    'External packages a core package entry evaluates on import.',
  'wide-records':
    'Public members past 20 on an exported class or `Context.Service` shape: a wide record, not a deep module.',
  'core-module-mocks':
    '`vi.mock` of a core module in a test: path-keyed mocks break on every move; provide a layer instead.',
  'non-erasable-syntax':
    'Parameter properties, enums, runtime namespaces or `import =` in core: the packages ship `.ts` that type stripping must run.',
  'ranged-dependencies':
    'A core package dependency not pinned to an exact version: replay assumes the behaviour recorded at write time.',
  'durable-invariants':
    'The harness README must number its durable invariants (`**I1**`), and a conformance test must cite each (`invariant I1`).',
  'decision-codes':
    'Internal decision codes (`D6`, `F3`, `#1234`) in core comments: state the rule or link the doc by path. Measured only, pending an owner ruling.',
};

/**
 * Rules the report counts but the gate does not hold: rule 10 of the study
 * waits on the owner's ruling about which codes stay as links.
 */
export const MEASURED_ONLY = new Set(['decision-codes']);

const SOURCE_FILE = /\.(?:ts|tsx|mts)$/;
const NOT_SOURCE = /\.d\.ts$|\.(?:test|vitest|spec)\.tsx?$/;

/** The repo-relative core source files, sorted. */
function coreFiles(rootDir) {
  return CORE_QUALITY_DIRS.flatMap((dir) =>
    walkFiles(path.join(rootDir, dir), {
      include: (file) => SOURCE_FILE.test(file) && !NOT_SOURCE.test(file),
      prune: (dir) => dir.endsWith('node_modules'),
    }).map(({ relativePath }) => `${dir}/${relativePath}`),
  ).toSorted();
}

function addSite(byRule, rule, file, line, detail) {
  const files = byRule.get(rule);
  const entry = files.get(file) ?? { value: 0, sites: [] };
  entry.value += 1;
  entry.sites.push({ line, detail });
  files.set(file, entry);
}

async function measureEslint(rootDir, files, byRule) {
  const eslint = new ESLint({
    cwd: rootDir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { '@typescript-eslint': tseslint.plugin },
        // A disable comment would hide debt from the count, so the ratchet
        // reads past it; the reason belongs in the code's shape instead.
        linterOptions: { noInlineConfig: true },
        rules: Object.fromEntries(
          ESLINT_RULES.map(([, id, options]) => [id, ['error', ...options]]),
        ),
      },
    ],
  });
  const ruleById = new Map(ESLINT_RULES.map(([name, id]) => [id, name]));
  for (const result of await eslint.lintFiles(files)) {
    const file = path.relative(rootDir, result.filePath).replaceAll('\\', '/');
    for (const message of result.messages) {
      const rule = ruleById.get(message.ruleId);
      if (rule == null) {
        if (message.fatal) throw new Error(`${file}: ${message.message}`);
        continue;
      }
      addSite(byRule, rule, file, message.line, message.message);
    }
  }
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Whether `block` runs Effect code directly, not inside a nested function. */
function runsEffectCode(block) {
  let found = false;
  const visit = (node) => {
    if (found || isFunctionLike(node)) return;
    if (ts.isYieldExpression(node) && node.asteriskToken != null) found = true;
    else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Effect'
    )
      found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return found;
}

// `packages/harness/src` counts as core here although the lint block lets a
// host package run effects: the SDK runs nothing itself (its README), so the
// ratchet holds it to the stricter core rule.
const RUN_NAMES = new Set([
  'runPromise',
  'runPromiseExit',
  'runSync',
  'runSyncExit',
  'runFork',
  'runCallback',
  'runMain',
]);

/** `() => undefined`, `() => null`, `() => []`, `() => {}`, `() => ({})`, literals. */
function returnsQuietValue(handler) {
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) {
    return false;
  }
  let body = handler.body;
  if (ts.isBlock(body)) {
    if (body.statements.length === 0) return true;
    const [only] = body.statements;
    if (body.statements.length !== 1 || !ts.isReturnStatement(only)) {
      return false;
    }
    if (only.expression == null) return true;
    body = only.expression;
  }
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  return (
    (ts.isIdentifier(body) && body.text === 'undefined') ||
    body.kind === ts.SyntaxKind.NullKeyword ||
    body.kind === ts.SyntaxKind.TrueKeyword ||
    body.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isVoidExpression(body) ||
    ts.isLiteralExpression(body) ||
    ts.isNoSubstitutionTemplateLiteral(body) ||
    (ts.isArrayLiteralExpression(body) && body.elements.length === 0) ||
    (ts.isObjectLiteralExpression(body) && body.properties.length === 0)
  );
}

/** `Effect.ignore` with no `log`, or logging only at debug level. */
function isQuietIgnore(node) {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.expression !== node) return true;
  const options = call.arguments.find(ts.isObjectLiteralExpression);
  const log = options?.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && property.name.getText() === 'log',
  );
  if (log == null) return true;
  const value = log.initializer.getText();
  return value === 'false' || /debug/i.test(value);
}

function hasDocComment(node, text) {
  return (ts.getLeadingCommentRanges(text, node.pos) ?? []).some(
    (range) =>
      text.startsWith('/**', range.pos) && !text.startsWith('/**/', range.pos),
  );
}

const DECLARATION_KINDS = [
  ts.isFunctionDeclaration,
  ts.isClassDeclaration,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isEnumDeclaration,
  ts.isVariableStatement,
  ts.isModuleDeclaration,
];

function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (statement.name != null) return [statement.name.getText()];
  // `export default function () {}` and `export default class {}`.
  return ts
    .getModifiers(statement)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ? ['default']
    : [];
}

/**
 * The file's exported declarations, by exported name: those carrying an
 * `export` modifier and those a local `export { … }` list names.
 */
function exportedDeclarations(sourceFile) {
  const declarations = new Map();
  const exported = new Map();
  for (const statement of sourceFile.statements) {
    if (!DECLARATION_KINDS.some((isKind) => isKind(statement))) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        exported.set('default', [statement]);
      }
      continue;
    }
    const isExported = ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const name of declaredNames(statement)) {
      const list = declarations.get(name) ?? [];
      list.push(statement);
      declarations.set(name, list);
      if (isExported) exported.set(name, list);
    }
  }
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier != null ||
      statement.exportClause == null ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      const local = (element.propertyName ?? element.name).getText();
      const list = declarations.get(local);
      if (list != null) exported.set(element.name.getText(), list);
    }
  }
  return exported;
}

/** Exported names none of whose declarations carries a TSDoc comment. */
function undocumentedExports(sourceFile) {
  const text = sourceFile.text;
  return [...exportedDeclarations(sourceFile)].flatMap(([name, list]) =>
    list.some((statement) => hasDocComment(statement, text))
      ? []
      : [{ node: list[0], name }],
  );
}

/** The decision-code shapes of the study's rule 10: `D6`, `HQ4b`, `#1234`. */
const DECISION_CODE = /\b[A-Z]{1,2}\d{1,2}[a-z]?\b|#\d{3,6}\b/g;

/** Public members an exported record may carry (study rule 11). */
const WIDE_RECORD_MEMBERS = 20;

const PARAMETER_PROPERTY = new Set([
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.OverrideKeyword,
]);

/** Whether a namespace holds a value, so it compiles to runtime code. */
function isInstantiated(node) {
  const body = node.body;
  if (body == null) return false;
  if (ts.isModuleDeclaration(body)) return isInstantiated(body);
  return body.statements.some(
    (statement) =>
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !(ts.isModuleDeclaration(statement) && !isInstantiated(statement)),
  );
}

const isHidden = (member) =>
  (member.name != null && ts.isPrivateIdentifier(member.name)) ||
  ts.isConstructorDeclaration(member) ||
  ts.isClassStaticBlockDeclaration(member) ||
  (ts.getModifiers(member) ?? []).some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );

/**
 * The members of a service shape: an inline type literal, or an interface or
 * type alias the same file declares under that name.
 */
function shapeMembers(shape, statement) {
  if (shape == null) return 0;
  if (ts.isTypeLiteralNode(shape)) return shape.members.length;
  if (!ts.isTypeReferenceNode(shape) || !ts.isIdentifier(shape.typeName)) {
    return 0;
  }
  const name = shape.typeName.text;
  for (const candidate of statement.getSourceFile().statements) {
    if (candidate.name?.text !== name) continue;
    if (ts.isInterfaceDeclaration(candidate)) return candidate.members.length;
    if (ts.isTypeAliasDeclaration(candidate)) {
      return shapeMembers(candidate.type, statement);
    }
  }
  return 0;
}

/**
 * An exported class's public member count; for a `Context.Service<Self,
 * Shape>()` class, the members of its shape literal as well.
 */
function wideRecord(statement, name) {
  if (!ts.isClassDeclaration(statement)) return null;
  let members = statement.members.filter((member) => !isHidden(member)).length;
  for (const clause of statement.heritageClauses ?? []) {
    for (const type of clause.types) {
      // `Context.Service<Self, Shape>()(key)`: the shape is the second
      // type argument of the inner call.
      for (
        let call = type.expression;
        ts.isCallExpression(call);
        call = call.expression
      ) {
        members += shapeMembers(call.typeArguments?.[1], statement);
      }
    }
  }
  return { name, members };
}

function measureAst(rootDir, files, byRule) {
  for (const file of files) {
    const text = readFileSync(path.join(rootDir, file), 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const lineOf = (node) =>
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1;
    const site = (rule, node, detail) =>
      addSite(byRule, rule, file, lineOf(node), detail);

    const lines = text.endsWith('\n')
      ? text.split('\n').length - 1
      : text.split('\n').length;
    if (lines > CORE_FILE_LINES) {
      byRule.get('file-size').set(file, {
        value: lines,
        sites: [{ line: 1, detail: `${lines} lines` }],
      });
    }

    for (const { node, name } of undocumentedExports(sourceFile)) {
      site('undocumented-exports', node, `export '${name}' has no TSDoc`);
    }

    const textLines = text.split('\n');
    const hasCastReason = (node) => {
      const line = lineOf(node);
      return /\/\/ cast:/.test(
        `${textLines[line - 2] ?? ''}\n${textLines[line - 1]}`,
      );
    };
    for (const comment of text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
      const codes = comment[0].match(DECISION_CODE) ?? [];
      if (codes.length === 0) continue;
      const line = text.slice(0, comment.index).split('\n').length;
      for (const code of codes) {
        addSite(byRule, 'decision-codes', file, line, code);
      }
    }
    for (const [name, [statement]] of exportedDeclarations(sourceFile)) {
      const record = wideRecord(statement, name);
      if (record != null && record.members > WIDE_RECORD_MEMBERS) {
        // The value is the excess, so a record that widens fails.
        for (let extra = WIDE_RECORD_MEMBERS; extra < record.members; extra++) {
          site(
            'wide-records',
            statement,
            `${record.name}: ${record.members} public members`,
          );
        }
      }
    }

    const visit = (node) => {
      // `let x!: T` and `field!: T`: the ESLint rule sees only `value!`.
      if (
        (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
        node.exclamationToken != null
      ) {
        site('no-non-null-assertion', node, 'definite assignment `!`');
      }
      if (
        ts.isParameter(node) &&
        ts
          .getModifiers(node)
          ?.some((modifier) => PARAMETER_PROPERTY.has(modifier.kind))
      ) {
        site('non-erasable-syntax', node, 'parameter property');
      } else if (
        ts.isEnumDeclaration(node) &&
        !ts
          .getModifiers(node)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      ) {
        site('non-erasable-syntax', node, `enum ${node.name.text}`);
      } else if (
        ts.isModuleDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        isInstantiated(node) &&
        !ts
          .getModifiers(node)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      ) {
        site('non-erasable-syntax', node, `namespace ${node.name.text}`);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
        site('non-erasable-syntax', node, 'import =');
      }
      if (
        ts.isAsExpression(node) &&
        !(
          ts.isTypeReferenceNode(node.type) &&
          node.type.typeName.getText() === 'const'
        ) &&
        !hasCastReason(node)
      ) {
        site('type-assertions', node, `as ${node.type.getText()}`);
      } else if (ts.isTypeAssertionExpression(node) && !hasCastReason(node)) {
        site('type-assertions', node, `<${node.type.getText()}>`);
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Promise'
      ) {
        site('new-promise', node, 'new Promise');
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        if (method === 'then') site('promise-then', node, '.then(');
        if (RUN_NAMES.has(method) && !EFFECT_RUN_ENTRIES.includes(file)) {
          site('effect-run', node, node.expression.getText());
        }
        if (
          method === 'catch' &&
          node.arguments.length === 1 &&
          returnsQuietValue(node.arguments[0])
        ) {
          site('silent-degradation', node, '.catch(() => value)');
        }
      } else if (ts.isTryStatement(node) && node.catchClause != null) {
        if (runsEffectCode(node.tryBlock)) {
          site('try-catch-effect', node, 'try/catch around Effect code');
        }
        if (node.catchClause.block.statements.length === 0) {
          site('silent-degradation', node.catchClause, 'empty catch block');
        }
      } else if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Effect'
      ) {
        const member = node.name.text;
        if (member === 'orElseSucceed') {
          site('silent-degradation', node, 'Effect.orElseSucceed');
        } else if (
          (member === 'ignore' || member === 'ignoreCause') &&
          isQuietIgnore(node)
        ) {
          site('silent-degradation', node, `Effect.${member} without a log`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

/** Strongly connected components of `graph` (Tarjan), as sets. */
function cycles(graph) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const connect = (node) => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = new Set();
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.add(member);
      } while (member !== node);
      if (component.size > 1) components.push(component);
    }
  };
  for (const node of graph.keys()) if (!indices.has(node)) connect(node);
  return components;
}

async function measureCycles(rootDir, files, byRule) {
  // One entry importing every core file: a bundle per file would cost a
  // minute; one bundle parses each module once.
  const { metafile } = await build({
    absWorkingDir: rootDir,
    stdin: {
      contents: files.map((file) => `import './${file}';`).join('\n'),
      resolveDir: rootDir,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    metafile: true,
    outfile: 'core-quality.js',
    platform: 'node',
    format: 'esm',
    packages: 'external',
    treeShaking: false,
    logLevel: 'silent',
  });
  const graph = new Map();
  for (const [input, { imports }] of Object.entries(metafile.inputs)) {
    graph.set(
      input,
      imports
        // A dynamic import defers loading, so it cannot close a cycle at
        // module evaluation.
        .filter(
          ({ external, kind }) => !external && kind === 'import-statement',
        )
        .map(({ path: target }) => target),
    );
  }
  const core = new Set(files);
  for (const component of cycles(graph)) {
    for (const file of component) {
      if (!core.has(file)) continue;
      for (const target of graph.get(file)) {
        if (component.has(target)) {
          addSite(byRule, 'import-cycles', file, 1, `imports ${target}`);
        }
      }
    }
  }
}

function measureReadmes(rootDir, byRule) {
  for (const dir of CORE_QUALITY_DIRS) {
    const root = dir.endsWith('/src') ? dir.slice(0, -'/src'.length) : dir;
    const readme = path.join(rootDir, root, 'README.md');
    const text = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
    if (!/```mermaid/.test(text)) {
      addSite(
        byRule,
        'missing-readme',
        `${root}/README.md`,
        1,
        text === '' ? 'no README' : 'README has no mermaid diagram',
      );
    }
  }
}

/** The external package name an import specifier names. */
const packageOf = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/**
 * Study rule 8: the repo files and external packages each core entry
 * evaluates on import, following value imports and re-exports only.
 */
function measureEntries(rootDir, options, byRule) {
  for (const { name, subpath, file: entryFile } of coreEntries(rootDir)) {
    const entry = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
    const seen = new Set();
    const externals = new Set();
    const stack = [entryFile];
    while (stack.length > 0) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        false,
      );
      for (const statement of source.statements) {
        const specifier = valueImportOf(statement);
        if (specifier == null) continue;
        const resolved = ts.resolveModuleName(
          specifier,
          file,
          options,
          ts.sys,
        ).resolvedModule;
        const target = resolved?.resolvedFileName;
        if (
          target != null &&
          !resolved.isExternalLibraryImport &&
          !target.includes('node_modules') &&
          /\.tsx?$/.test(target) &&
          !target.endsWith('.d.ts')
        ) {
          stack.push(path.resolve(target));
        } else {
          externals.add(packageOf(specifier));
        }
      }
    }
    const files = byRule.get('entry-files');
    files.set(entry, {
      value: seen.size,
      sites: [{ line: 1, detail: `${seen.size} repo files` }],
    });
    byRule.get('entry-externals').set(entry, {
      value: externals.size,
      sites: [{ line: 1, detail: [...externals].toSorted().join(' ') }],
    });
  }
}

/** The specifier a statement evaluates, or null for type-only imports. */
function valueImportOf(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return null;
    const bindings = clause?.namedBindings;
    if (
      clause != null &&
      clause.name == null &&
      bindings != null &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    ) {
      return null;
    }
    return statement.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier != null &&
    !statement.isTypeOnly
  ) {
    const clause = statement.exportClause;
    if (
      clause != null &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly)
    ) {
      return null;
    }
    return statement.moduleSpecifier.text;
  }
  return null;
}

/** A core package, which a test may name directly. */
const CORE_PACKAGE = /^@texra-ai\/(?:llm|agent)(?:\/|$)/;

/**
 * Study rule 12: `vi.mock` of a core module, per test file. A target is
 * core when it resolves (alias or relative path) to a measured core file,
 * so the app-path exclusions apply here too.
 */
function measureMocks(rootDir, files, options, byRule) {
  const core = new Set(files);
  const tests = walkFiles(path.join(rootDir, 'src/test-kernel'), {
    include: (file) => /\.(?:vitest|test)\.tsx?$/.test(file),
  });
  for (const { absolutePath } of tests) {
    const file = path.relative(rootDir, absolutePath).replaceAll('\\', '/');
    const text = readFileSync(absolutePath, 'utf8');
    for (const match of text.matchAll(
      /\bvi\.(?:mock|doMock)\(\s*['"`]([^'"`]+)/g,
    )) {
      const target = match[1];
      const resolved = ts.resolveModuleName(
        target,
        absolutePath,
        options,
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      const resolvedFile =
        resolved == null
          ? null
          : path
              .relative(rootDir, realpathSync(resolved))
              .replaceAll('\\', '/');
      if (CORE_PACKAGE.test(target) || core.has(resolvedFile)) {
        const line = text.slice(0, match.index).split('\n').length;
        addSite(byRule, 'core-module-mocks', file, line, target);
      }
    }
  }
}

/**
 * Study rule 14: core package dependencies that are not an exact version,
 * with `catalog:` read through the workspace catalog.
 */
function measureDependencies(rootDir, byRule) {
  const { catalog = {} } = parseYaml(
    readFileSync(path.join(rootDir, 'pnpm-workspace.yaml'), 'utf8'),
  );
  for (const dir of ['packages/harness', 'packages/llm']) {
    const manifest = JSON.parse(
      readFileSync(path.join(rootDir, dir, 'package.json'), 'utf8'),
    );
    for (const [name, spelled] of Object.entries({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      if (spelled.startsWith('workspace:')) continue;
      const range = spelled === 'catalog:' ? catalog[name] : spelled;
      if (/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(range ?? '')) continue;
      addSite(
        byRule,
        'ranged-dependencies',
        `${dir}/package.json`,
        1,
        `${name}@${range}`,
      );
    }
  }
}

/**
 * Study rule 16: the harness README numbers its durable invariants
 * (`**I1**`), and a conformance test cites each one (`invariant I1`).
 */
function measureInvariants(rootDir, byRule) {
  const readme = 'packages/harness/README.md';
  const text = readFileSync(path.join(rootDir, readme), 'utf8');
  const listed = [...text.matchAll(/\*\*(I\d+)\*\*/g)].map((match) => match[1]);
  // Two keys: an empty catalog must not hide the first untested invariant.
  if (listed.length === 0) {
    addSite(
      byRule,
      'durable-invariants',
      `${readme} (catalog)`,
      1,
      'no numbered invariants',
    );
    return;
  }
  const tests = `${readme} (tests)`;
  const cited = new Set();
  for (const { absolutePath } of walkFiles(
    path.join(rootDir, 'src/test-kernel'),
    {
      include: (file) => file.endsWith('.vitest.ts'),
    },
  )) {
    for (const match of readFileSync(absolutePath, 'utf8').matchAll(
      /\binvariant (I\d+)\b/g,
    )) {
      cited.add(match[1]);
    }
  }
  for (const invariant of new Set(listed)) {
    if (!cited.has(invariant)) {
      addSite(
        byRule,
        'durable-invariants',
        tests,
        1,
        `${invariant} has no test`,
      );
    }
  }
  for (const invariant of cited) {
    if (!listed.includes(invariant)) {
      addSite(
        byRule,
        'durable-invariants',
        tests,
        1,
        `a test cites unlisted ${invariant}`,
      );
    }
  }
}

/**
 * Every rule's findings: `Map<rule, Map<key, { value, sites }>>`. The key is
 * a repo file, or a package entry for the entry rules. `value` is the site
 * count, except for file-size (line count) and the entry rules (files or
 * packages reached).
 */
export async function measure(rootDir) {
  const files = coreFiles(rootDir);
  const byRule = new Map(Object.keys(RULES).map((rule) => [rule, new Map()]));
  await measureEslint(rootDir, files, byRule);
  measureAst(rootDir, files, byRule);
  await measureCycles(rootDir, files, byRule);
  measureReadmes(rootDir, byRule);
  // The repo's module resolution (its `paths` aliases), for the graph rules.
  const { options } = ts.getParsedCommandLineOfConfigFile(
    path.join(rootDir, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  measureEntries(rootDir, options, byRule);
  measureMocks(rootDir, files, options, byRule);
  measureDependencies(rootDir, byRule);
  measureInvariants(rootDir, byRule);
  return { files, byRule };
}
