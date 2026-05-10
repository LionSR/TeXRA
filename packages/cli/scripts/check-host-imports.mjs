#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(cliRoot));
const cliSrc = join(cliRoot, 'src');
const forbiddenImports = new Set(['vscode', 'electron']);

const processInputPatterns = [
  { name: 'process.argv', pattern: /\bprocess\.argv\b/ },
  { name: 'process.cwd()', pattern: /\bprocess\.cwd\s*\(/ },
  { name: 'process.env', pattern: /\bprocess\.env\b/ },
];

const processInputAllowedFiles = new Set([
  'packages/cli/src/runtime/cliContext.ts',
]);

const processTerminalInputAllowedFiles = new Set([
  'packages/cli/src/runtime/cliContext.ts',
]);

const processOutputAllowedFiles = new Set([
  'packages/cli/src/bin/texra.ts',
  'packages/cli/src/runtime/logSinks.ts',
]);

const processOutputPatterns = [
  { name: 'process.exitCode', pattern: /\bprocess\.exitCode\b/ },
  { name: 'process.stdout', pattern: /\bprocess\.stdout\b/ },
  { name: 'process.stderr', pattern: /\bprocess\.stderr\b/ },
];

const processTerminalInputPatterns = [
  { name: 'process.stdout.isTTY', pattern: /\bprocess\.stdout\.isTTY\b/g },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* walk(path);
    } else if (path.endsWith('.ts') || path.endsWith('.tsx')) {
      yield path;
    }
  }
}

function importSources(source) {
  const sources = [];
  const importPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^'\"]+\s+from\s+)?['\"]([^'\"]+)['\"]/g;
  let match;
  while ((match = importPattern.exec(source)) != null) {
    sources.push(match[1]);
  }
  return sources;
}

const errors = [];

for (const file of walk(cliSrc)) {
  const rel = relative(repoRoot, file);
  const source = readFileSync(file, 'utf8');

  for (const imported of importSources(source)) {
    const root = imported.split('/')[0];
    if (forbiddenImports.has(imported) || forbiddenImports.has(root)) {
      errors.push(
        `${rel}: direct host import '${imported}' is forbidden in the CLI package`,
      );
    }
  }

  if (!processInputAllowedFiles.has(rel)) {
    for (const { name, pattern } of processInputPatterns) {
      if (pattern.test(source)) {
        errors.push(
          `${rel}: ${name} must be read through runtime/cliContext.ts`,
        );
      }
    }
  }

  let outputSource = source;
  if (processTerminalInputAllowedFiles.has(rel)) {
    for (const { pattern } of processTerminalInputPatterns) {
      outputSource = outputSource.replace(pattern, '');
    }
  }

  if (!processOutputAllowedFiles.has(rel)) {
    for (const { name, pattern } of processOutputPatterns) {
      if (pattern.test(outputSource)) {
        errors.push(`${rel}: ${name} must stay at the CLI boundary`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error('CLI architecture check failed:\n');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}
