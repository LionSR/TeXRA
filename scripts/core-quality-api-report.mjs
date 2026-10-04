// Generates the public-surface report of each core package entry
// (config/api-reports/<package>[.<subpath>].api.md): one line per export,
// with its kind and type, so a change to the public surface shows up as a
// diff in review. The entries are read from each package's `exports`.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const PACKAGES = ['packages/agent', 'packages/llm'];

/**
 * `{ name, subpath, file, report }` for every entry the core packages export;
 * the entry-reach budgets read the same list.
 */
export function coreEntries(rootDir) {
  return PACKAGES.flatMap((dir) => {
    const manifest = JSON.parse(
      readFileSync(path.join(rootDir, dir, 'package.json'), 'utf8'),
    );
    return Object.entries(manifest.exports).map(([subpath, target]) => {
      const spelled = typeof target === 'string' ? target : target.types;
      const base = path.basename(spelled).replace(/\.d\.ts$|\.ts$/, '');
      return {
        name: manifest.name,
        subpath,
        file: path.join(rootDir, dir, 'src', `${base}.ts`),
        report: `${path.basename(dir)}${subpath === '.' ? '' : `.${subpath.slice(2)}`}.api.md`,
      };
    });
  });
}

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

function describe(checker, symbol) {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const declaration = target.declarations?.[0];
  if (declaration == null) return `unknown ${symbol.name}`;
  const kind = kindOf(declaration);
  if (kind === 'interface' || kind === 'type' || kind === 'enum') {
    const text = printer
      .printNode(
        ts.EmitHint.Unspecified,
        declaration,
        declaration.getSourceFile(),
      )
      .replace(/^export (?:declare )?/, '');
    return text.replaceAll(/\s+/g, ' ');
  }
  if (kind === 'class') {
    const members = checker
      .getPropertiesOfType(checker.getTypeOfSymbol(target))
      .filter((member) => member.name !== 'prototype')
      .map((member) => member.name)
      .toSorted();
    const instance = checker
      .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target))
      .map((member) => member.name)
      .toSorted();
    return `class ${symbol.name} { static: ${members.join(', ')}; instance: ${instance.join(', ')} }`;
  }
  const type = checker.getTypeOfSymbolAtLocation(target, declaration);
  return `${kind} ${symbol.name}: ${checker.typeToString(type)}`;
}

/** Report file name → report text, one per core package entry. */
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
    list.map(({ name, subpath, file, report }) => {
      const sourceFile = program.getSourceFile(file);
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      const exports = checker
        .getExportsOfModule(moduleSymbol)
        .toSorted((left, right) => left.name.localeCompare(right.name));
      const lines = exports.map(
        (symbol) => `- \`${symbol.name}\` — \`${describe(checker, symbol)}\``,
      );
      const entry = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
      return [
        report,
        [
          `# \`${entry}\` API report`,
          '',
          `Generated from \`${path.relative(rootDir, file)}\` by \`node scripts/check-core-quality.mjs --update\`; do not edit. A diff here is a change to the public surface.`,
          '',
          `Exports: ${exports.length}`,
          '',
          ...lines,
          '',
        ].join('\n'),
      ];
    }),
  );
}
