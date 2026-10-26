// Generates two documents for each core package entry, from one type-checked
// program over the entries read from each package's `exports`:
// - the public-surface report (config/api-reports/<package>[.<subpath>].api.md):
//   one line per export, with its kind and type, so a change to the public
//   surface shows up as a diff in review;
// - the API reference (packages/<package>/docs/api/<entry>.md), shipped in the
//   package: each export's TSDoc and declaration, for a reader of the package.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const PACKAGES = ['packages/harness', 'packages/llm'];

/**
 * `{ name, subpath, file, report }` for every entry the core packages export;
 * the entry-reach budgets read the same list.
 */
export function coreEntries(rootDir) {
  return PACKAGES.flatMap((dir) => {
    const manifest = JSON.parse(
      readFileSync(path.join(rootDir, dir, 'package.json'), 'utf8'),
    );
    const entries = Object.entries(manifest.exports).filter(
      ([subpath]) => subpath !== './package.json',
    );
    return entries.map(([subpath, target]) => {
      const spelled = typeof target === 'string' ? target : target.types;
      // `./src/foo/bar.ts`, or its built declaration
      // `./dist/types/foo/bar.d.ts`: the path under `src/`.
      const source = spelled
        .replace(/^\.\/(?:src|dist\/types)\//, '')
        .replace(/\.d\.ts$|\.ts$/, '');
      return {
        name: manifest.name,
        subpath,
        file: path.join(rootDir, dir, 'src', `${source}.ts`),
        report: `${path.basename(dir)}${subpath === '.' ? '' : `.${subpath.slice(2)}`}.api.md`,
        reference: `${dir}/docs/api/${subpath === '.' ? 'index' : subpath.slice(2)}.md`,
      };
    });
  });
}

/** A markdown code span for `text`: its fence is one backtick longer than
 *  the longest backtick run inside (a type can carry a string literal that
 *  quotes code), so Prettier reads it as one span and leaves it alone. */
const codeSpan = (text) => {
  const runs = text.match(/`+/g) ?? [];
  if (runs.length === 0) return `\`${text}\``;
  const fence = '`'.repeat(Math.max(...runs.map((run) => run.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
};
/** One export's line in a report. */
const reportLine = (name, description) =>
  `- ${codeSpan(name)} — ${codeSpan(description)}`;

function kindOf(declaration) {
  if (ts.isInterfaceDeclaration(declaration)) return 'interface';
  if (ts.isTypeAliasDeclaration(declaration)) return 'type';
  if (ts.isClassDeclaration(declaration)) return 'class';
  if (ts.isEnumDeclaration(declaration)) return 'enum';
  if (ts.isFunctionDeclaration(declaration)) return 'function';
  if (ts.isModuleDeclaration(declaration)) return 'namespace';
  return 'const';
}

const printer = ts.createPrinter({ removeComments: true });
const scratch = ts.createSourceFile('report.ts', '', ts.ScriptTarget.Latest);

/**
 * `typeToString`'s flags, untruncated: an elided `... 17 more ...` would hide
 * a change.
 */
const FULL =
  ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope |
  ts.NodeBuilderFlags.AllowUniqueESSymbolType |
  ts.NodeBuilderFlags.IgnoreErrors;

/** Text order, independent of the locale. */
const byText = (left, right) =>
  left.text < right.text ? -1 : left.text > right.text ? 1 : 0;

/**
 * The checker orders a union's members, and a mapped type's properties (a
 * `ZodEnum<{ a: "a"; b: "b" }>`), by type id, which follows the order the
 * program happened to create them, so an edit anywhere in the program can
 * reorder a printed type. Each union prints with its members sorted by their
 * own text, and each object literal with its properties sorted by name;
 * call, construct and index signatures keep their places.
 */
const sortedTypes = (context) => {
  const { factory } = context;
  const visit = (node) => {
    const visited = ts.visitEachChild(node, visit, context);
    if (ts.isUnionTypeNode(visited)) {
      const members = visited.types
        .map((member) => ({ member, text: printNode(member) }))
        .toSorted(byText)
        .map(({ member }) => member);
      return factory.updateUnionTypeNode(
        visited,
        factory.createNodeArray(members),
      );
    }
    if (ts.isTypeLiteralNode(visited)) {
      const properties = visited.members
        .filter(ts.isPropertySignature)
        .map((member) => ({ member, text: printNode(member.name) }))
        .toSorted(byText)
        .map(({ member }) => member);
      const members = visited.members.map((member) =>
        ts.isPropertySignature(member) ? properties.shift() : member,
      );
      return factory.updateTypeLiteralNode(
        visited,
        factory.createNodeArray(members),
      );
    }
    return visited;
  };
  return visit;
};

function printNode(node) {
  return printer.printNode(ts.EmitHint.Unspecified, node, scratch);
}

/** A synthesized type or signature node, printed in a stable order. */
function printSorted(node) {
  if (node == null) throw new Error('The checker could not print a type.');
  const [sorted] = ts.transform(node, [sortedTypes]).transformed;
  return printNode(sorted);
}

const typeText = (checker, type) =>
  printSorted(checker.typeToTypeNode(type, undefined, FULL));

function describe(checker, symbol) {
  const { target, declaration, kind } = exportTarget(checker, symbol);
  if (declaration == null) return `unknown ${symbol.name}`;
  if (kind === 'interface' || kind === 'type' || kind === 'enum') {
    const text = printer
      .printNode(
        ts.EmitHint.Unspecified,
        declaration,
        declaration.getSourceFile(),
      )
      .replace(/^export (?:declare )?/, '')
      .replaceAll(/\s+/g, ' ');
    if (kind !== 'type') return text;
    // An alias to a type the package does not export changes with that
    // type, so the report carries the resolved shape too.
    const resolved = typeText(checker, checker.getDeclaredTypeOfSymbol(target));
    return `${text} ≡ ${resolved}`;
  }
  if (kind === 'class') {
    const signatures = (type) =>
      checker
        .getPropertiesOfType(type)
        .filter(
          (member) =>
            member.name !== 'prototype' &&
            !(member.declarations ?? []).some(
              (memberDeclaration) =>
                (ts.getCombinedModifierFlags(memberDeclaration) &
                  (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
                  0 ||
                (memberDeclaration.name != null &&
                  ts.isPrivateIdentifier(memberDeclaration.name)),
            ),
        )
        .map(
          (member) =>
            // A symbol-keyed member's name carries the compilation's symbol
            // id (`__@iterator@127`), which shifts with any dependency.
            `${member.name.replace(/^__@(.+)@\d+$/, '[$1]')}: ${typeText(checker, checker.getTypeOfSymbolAtLocation(member, declaration))}`,
        )
        .toSorted();
    const staticType = checker.getTypeOfSymbol(target);
    const constructors = staticType
      .getConstructSignatures()
      .map((signature) =>
        printSorted(
          checker.signatureToSignatureDeclaration(
            signature,
            ts.SyntaxKind.ConstructorType,
            undefined,
            FULL,
          ),
        ),
      );
    const statics = signatures(staticType);
    const instance = signatures(checker.getDeclaredTypeOfSymbol(target));
    return `class ${symbol.name} { constructor: ${constructors.join(' | ')}; static: ${statics.join('; ')}; instance: ${instance.join('; ')} }`;
  }
  const type = checker.getTypeOfSymbolAtLocation(target, declaration);
  return `${kind} ${symbol.name}: ${typeText(checker, type)}`;
}

/** The declaration an export names, and its kind. */
function exportTarget(checker, symbol) {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const declaration = target.declarations?.[0];
  return {
    target,
    declaration,
    kind: declaration == null ? 'unknown' : kindOf(declaration),
  };
}

/** An export's TSDoc as markdown: its comment, then its tags. */
function docText(checker, target) {
  const comment = ts.displayPartsToString(
    target.getDocumentationComment(checker),
  );
  const tags = target.getJsDocTags(checker).map((tag) => {
    // Continuation lines stay inside the tag's bullet.
    const text = ts.displayPartsToString(tag.text).replace(/\n/g, '\n  ');
    return `- \`@${tag.name}\`${text === '' ? '' : ` ${text}`}`;
  });
  return [comment, tags.join('\n')].filter((part) => part !== '').join('\n\n');
}

/** An export's declaration as written, without bodies: a function's
 *  signature, a class's heading, a constant's declared or inferred type. */
function declarationText(checker, symbol) {
  const { target, declaration, kind } = exportTarget(checker, symbol);
  if (declaration == null) return `unknown ${symbol.name}`;
  const upTo = (node) =>
    declaration
      .getText()
      .slice(0, node.getStart() - declaration.getStart())
      .trimEnd();
  const written = (text) =>
    text.replace(/^export (?:declare )?(?:default )?/, '');
  if (ts.isFunctionDeclaration(declaration) && declaration.body != null)
    return written(upTo(declaration.body));
  if (ts.isClassDeclaration(declaration)) {
    const open = declaration
      .getChildren()
      .find((child) => child.kind === ts.SyntaxKind.OpenBraceToken);
    return written(open == null ? declaration.getText() : upTo(open));
  }
  if (kind !== 'const') return written(declaration.getText());
  const type =
    ts.isVariableDeclaration(declaration) && declaration.type != null
      ? declaration.type.getText()
      : checker.typeToString(
          checker.getTypeOfSymbolAtLocation(target, declaration),
          undefined,
          ts.TypeFormatFlags.NoTruncation |
            ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
        );
  return `const ${symbol.name}: ${type}`;
}

/** Each export's heading, TSDoc and declaration. */
const referenceText = (checker, entry, source, exports) =>
  [
    `# \`${entry}\``,
    '',
    `<!-- Generated from \`${source}\` by \`npm run docgen\`; do not edit. -->`,
    ...exports.flatMap((symbol) => {
      const doc = docText(checker, exportTarget(checker, symbol).target);
      return [
        '',
        `## ${symbol.name}`,
        ...(doc === '' ? [] : ['', doc]),
        '',
        '```ts',
        declarationText(checker, symbol),
        '```',
      ];
    }),
    '',
  ].join('\n');

/** Directories (repo-relative) whose files `apiReports` writes in full. */
export const GENERATED_DIRS = [
  'config/api-reports',
  'packages/harness/docs/api',
  'packages/llm/docs/api',
];

/** Repo-relative path → text: the report and the reference of each core
 *  package entry. */
export function apiReports(rootDir) {
  const list = coreEntries(rootDir);
  const configPath = path.join(rootDir, 'tsconfig.build.json');
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, rootDir);
  const program = ts.createProgram(
    list.map(({ file }) => file),
    { ...options, noEmit: true },
  );
  const checker = program.getTypeChecker();
  return new Map(
    list.flatMap(({ name, subpath, file, report, reference }) => {
      const sourceFile = program.getSourceFile(file);
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      const exports = checker
        .getExportsOfModule(moduleSymbol)
        .toSorted((left, right) => left.name.localeCompare(right.name));
      const lines = exports.map((symbol) =>
        reportLine(symbol.name, describe(checker, symbol)),
      );
      const entry = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
      const source = path.relative(rootDir, file);
      return [
        [
          `config/api-reports/${report}`,
          [
            `# \`${entry}\` API report`,
            '',
            `Generated from \`${source}\` by \`node scripts/check-core-quality.mjs --update\`; do not edit. A diff here is a change to the public surface.`,
            '',
            `Exports: ${exports.length}`,
            '',
            ...lines,
            '',
          ].join('\n'),
        ],
        [reference, referenceText(checker, entry, source, exports)],
      ];
    }),
  );
}
