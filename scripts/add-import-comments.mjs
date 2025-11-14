#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const INTERNAL_ALIAS_NAMES = [
  'agent',
  'common',
  'frontend',
  'historyView',
  'logger',
  'model',
  'progressView',
  'replacement',
  'tools',
  'utils',
  'eventBus',
  'webview',
  'latex',
  'commands',
  'housekeeping',
  'types',
];

const INTERNAL_ALIAS_PREFIXES = INTERNAL_ALIAS_NAMES.flatMap((alias) => [
  `@${alias}`,
  `@${alias}/`,
]);

function isTypeOnlyImport(node) {
  const clause = node.importClause;
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    return (
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((el) => el.isTypeOnly)
    );
  }
  return false;
}

function isInternalModule(specifier) {
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    return true;
  }
  return INTERNAL_ALIAS_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(prefix));
}

function classifyImport(node) {
  const specifier = node.moduleSpecifier.text;
  if (!specifier) {
    return 'Imports';
  }
  if (isTypeOnlyImport(node)) {
    return 'Type imports';
  }
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
    return 'Node.js built-in imports';
  }
  if (specifier.startsWith('.')) {
    return 'Local file imports';
  }
  if (isInternalModule(specifier)) {
    return 'Internal imports';
  }
  return 'Third-party imports';
}

function hasLeadingComment(fileText, node) {
  const start = node.getStart();
  const currentLineStart = fileText.lastIndexOf('\n', start - 1) + 1;
  const previousLineEnd = currentLineStart - 1;
  if (previousLineEnd < 0) {
    return false;
  }
  const previousLineStart = fileText.lastIndexOf('\n', previousLineEnd - 1) + 1;
  const previousLine = fileText.slice(previousLineStart, previousLineEnd).trim();
  return previousLine.startsWith('//') || previousLine.startsWith('/*');
}

function applyEdits(text, edits) {
  if (edits.length === 0) {
    return text;
  }
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let updated = text;
  sorted.forEach(({ start, end, text: replacement }) => {
    updated = `${updated.slice(0, start)}${replacement}${updated.slice(end)}`;
  });
  return updated;
}

function ensureCommentForFile(filePath) {
  const fileText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, fileText, ts.ScriptTarget.Latest, true);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (imports.length === 0) {
    return false;
  }

  const edits = [];

  imports.forEach((node, index) => {
    const previous = index > 0 ? imports[index - 1] : undefined;
    const currentStartLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
    const previousEndLine = previous
      ? sourceFile.getLineAndCharacterOfPosition(previous.getEnd()).line
      : undefined;
    const hasBlankLine = previousEndLine !== undefined ? currentStartLine - previousEndLine > 1 : false;
    const isGroupStart = !previous || hasBlankLine;
    if (previous) {
      const previousClass = classifyImport(previous);
      const currentClass = classifyImport(node);
      if (previousClass === currentClass && hasBlankLine) {
        const gapStart = previous.getEnd();
        const gapEnd = node.getStart();
        const gapText = fileText.slice(gapStart, gapEnd);
        const normalizedGap = gapText.replace(/\n\s*\n/g, '\n');
        if (normalizedGap !== gapText) {
          edits.push({ start: gapStart, end: gapEnd, text: normalizedGap });
        }
      }
    }
    if (!isGroupStart) {
      return;
    }
    if (hasLeadingComment(fileText, node)) {
      return;
    }
    const commentLabel = classifyImport(node);
    const lineStart = fileText.lastIndexOf('\n', node.getStart() - 1) + 1;
    const insertionPos = lineStart >= 0 ? lineStart : 0;
    edits.push({ start: insertionPos, end: insertionPos, text: `// ${commentLabel}\n` });
  });

  if (edits.length === 0) {
    return false;
  }

  const updatedText = applyEdits(fileText, edits);
  fs.writeFileSync(filePath, updatedText, 'utf8');
  return true;
}

function collectFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  entries.forEach((entry) => {
    if (entry.isDirectory()) {
      files.push(...collectFiles(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path.join(dir, entry.name));
    }
  });
  return files;
}

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const srcDir = path.join(rootDir, 'src');
const allFiles = collectFiles(srcDir);
let changedCount = 0;
allFiles.forEach((file) => {
  if (ensureCommentForFile(file)) {
    changedCount += 1;
  }
});

if (changedCount > 0) {
  console.log(`Updated import groups in ${changedCount} files.`);
}
