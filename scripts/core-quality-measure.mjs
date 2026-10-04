// Measures the core-quality rules over CORE_QUALITY_DIRS (eslint.config.mjs).
// Each rule yields its sites per file; check-core-quality.mjs compares the
// per-file counts with config/ratchets/core-quality/<rule>.json.
//
// The ESLint half runs ESLint's own rules without type information, so it
// is fast and needs no project. The AST half reads each file with the
// TypeScript parser. Import cycles come from esbuild's metafile: esbuild
// erases type-only imports and resolves the tsconfig aliases, so its graph
// is exactly the runtime module graph.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';
import { ESLint } from 'eslint';
import ts from 'typescript';
import tseslint from 'typescript-eslint';

import {
  CORE_QUALITY_APP_PATHS,
  CORE_QUALITY_DIRS,
  EFFECT_RUN_ENTRIES,
} from '../eslint.config.mjs';
import { walkFiles } from './walkFiles.mjs';

/** Lines a core file may hold before it needs a budget row. */
const CORE_FILE_LINES = 400;

/**
 * The ESLint-measured rules: baseline name, rule id and options. Thresholds
 * are the owner's bar of 2026-10-03; complexity 15 is ESLint's long-standing
 * recommendation for "needs a design look", not a split target.
 */
const ESLINT_RULES = [
  ['no-explicit-any', '@typescript-eslint/no-explicit-any', []],
  ['no-non-null-assertion', '@typescript-eslint/no-non-null-assertion', []],
  [
    'explicit-module-boundary-types',
    '@typescript-eslint/explicit-module-boundary-types',
    [],
  ],
  ['complexity', 'complexity', [15]],
  ['max-depth', 'max-depth', [4]],
  ['max-params', 'max-params', [4]],
  [
    'max-lines-per-function',
    'max-lines-per-function',
    [{ max: 60, skipBlankLines: true, skipComments: true }],
  ],
];

/** Every rule, in report order, with the one line the report prints. */
export const RULES = {
  'no-explicit-any': '`any` disables the checker for everything it touches.',
  'no-non-null-assertion':
    '`!` asserts a fact the types do not hold; model it so the value cannot be absent.',
  'type-assertions':
    '`as` (other than `as const`) overrides the checker; a schema decode or a narrower type removes it.',
  'explicit-module-boundary-types':
    'An exported function states its contract instead of leaking an inferred one.',
  'undocumented-exports':
    'Every exported declaration carries a TSDoc comment saying what it is for.',
  'import-cycles':
    'Runtime import edges inside a cycle; a cycle means two modules share one owner.',
  'file-size': `A core file over ${CORE_FILE_LINES} lines holds more than one responsibility.`,
  complexity:
    'Functions over cyclomatic complexity 15: special cases a better data shape would remove.',
  'max-depth':
    'Blocks nested deeper than 4: control flow standing in for a data structure.',
  'max-params':
    'Functions with more than 4 parameters: take an options object or a service.',
  'max-lines-per-function':
    'Functions over 60 code lines: more than one job in one body.',
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
};

const SOURCE_FILE = /\.(?:ts|mts)$/;
const NOT_SOURCE = /\.d\.ts$|\.(?:test|vitest|spec)\.ts$/;

function appPathMatcher() {
  const patterns = CORE_QUALITY_APP_PATHS.map((entry) =>
    entry.includes('*')
      ? new RegExp(`^${entry.replaceAll('.', '\\.').replaceAll('*', '[^/]*')}$`)
      : new RegExp(`^${entry.replaceAll('.', '\\.')}(?:/|$)`),
  );
  return (file) => patterns.some((pattern) => pattern.test(file));
}

/** The repo-relative core source files, sorted. */
function coreFiles(rootDir) {
  const isAppPath = appPathMatcher();
  return CORE_QUALITY_DIRS.flatMap((dir) =>
    walkFiles(path.join(rootDir, dir), {
      include: (file) => SOURCE_FILE.test(file) && !NOT_SOURCE.test(file),
      prune: (dir) => dir.endsWith('node_modules'),
    }).map(({ relativePath }) => `${dir}/${relativePath}`),
  )
    .filter((file) => !isAppPath(file))
    .toSorted();
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
        files: ['**/*.ts', '**/*.mts'],
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
  return statement.name != null ? [statement.name.getText()] : [];
}

/** Exported declarations, by name, with whether any declaration is documented. */
function undocumentedExports(sourceFile) {
  const text = sourceFile.text;
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
  return [...exported].flatMap(([name, list]) =>
    list.some((statement) => hasDocComment(statement, text))
      ? []
      : [{ node: list[0], name }],
  );
}

function measureAst(rootDir, files, byRule) {
  for (const file of files) {
    const text = readFileSync(path.join(rootDir, file), 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
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

    const visit = (node) => {
      if (
        ts.isAsExpression(node) &&
        !(
          ts.isTypeReferenceNode(node.type) &&
          node.type.typeName.getText() === 'const'
        )
      ) {
        site('type-assertions', node, `as ${node.type.getText()}`);
      } else if (ts.isTypeAssertionExpression(node)) {
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

/**
 * Every rule's findings: `Map<rule, Map<file, { value, sites }>>`. `value`
 * is the site count, except for file-size, where it is the line count.
 */
export async function measure(rootDir) {
  const files = coreFiles(rootDir);
  const byRule = new Map(Object.keys(RULES).map((rule) => [rule, new Map()]));
  await measureEslint(rootDir, files, byRule);
  measureAst(rootDir, files, byRule);
  await measureCycles(rootDir, files, byRule);
  measureReadmes(rootDir, byRule);
  return { files, byRule };
}
