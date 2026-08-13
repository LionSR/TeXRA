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
  // Ink needs the actual `process.stdin` stream object to wire its raw-mode
  // input pipeline; this file is the TUI I/O boundary.
  'packages/cli/src/chat/tui/runChatTui.tsx',
  'packages/cli/src/orchestration/runOrchestrationTui.tsx',
  'packages/cli/src/init/runInitWizard.tsx',
  'packages/cli/src/config/runConfigTui.tsx',
]);

const processTerminalInputAllowedFiles = new Set([
  'packages/cli/src/runtime/cliContext.ts',
  'packages/cli/src/chat/tui/runChatTui.tsx',
  'packages/cli/src/orchestration/runOrchestrationTui.tsx',
  // First-run onboarding mounts Ink and uses process.stdout.isTTY as its
  // defensive TTY guard, like the other interactive launchers.
  'packages/cli/src/onboarding/runOnboarding.tsx',
]);

const processOutputAllowedFiles = new Set([
  'packages/cli/src/bin/texra.ts',
  'packages/cli/src/runtime/logSinks.ts',
  // Ink mounts onto real `process.stdout`/`process.stderr` streams; the rest
  // of the TUI must keep going through logSinks.
  'packages/cli/src/chat/tui/runChatTui.tsx',
  'packages/cli/src/orchestration/runOrchestrationTui.tsx',
  'packages/cli/src/init/runInitWizard.tsx',
  'packages/cli/src/onboarding/runOnboarding.tsx',
  'packages/cli/src/commands/loginProviderPicker.tsx',
  'packages/cli/src/config/runConfigTui.tsx',
]);

const processOutputPatterns = [
  { name: 'console.log', pattern: /\bconsole\.log\s*\(/ },
  { name: 'console.error', pattern: /\bconsole\.error\s*\(/ },
  { name: 'console.warn', pattern: /\bconsole\.warn\s*\(/ },
  { name: 'process.exitCode', pattern: /\bprocess\.exitCode\b/ },
  { name: 'process.stdout', pattern: /\bprocess\.stdout\b/ },
  { name: 'process.stderr', pattern: /\bprocess\.stderr\b/ },
];

const processTerminalInputPatterns = [
  { name: 'process.stdout.isTTY', pattern: /\bprocess\.stdout\.isTTY\b/g },
  { name: 'process.stderr.isTTY', pattern: /\bprocess\.stderr\.isTTY\b/g },
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
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'\"]+\s+from\s+)?['\"]([^'\"]+)['\"]/g,
    /\bimport\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
    /\brequire\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      sources.push(match[1]);
    }
  }
  return sources;
}

function isForbiddenImport(imported) {
  const root = imported.split('/')[0];
  return forbiddenImports.has(imported) || forbiddenImports.has(root);
}

function forbiddenImportMessage(rel, imported) {
  return `${rel}: host import '${imported}' is forbidden in the CLI package`;
}

function checkImports(rel, source) {
  for (const imported of importSources(source)) {
    if (isForbiddenImport(imported)) {
      errors.push(forbiddenImportMessage(rel, imported));
    }
  }
}

function patternMatches(pattern, source) {
  pattern.lastIndex = 0;
  return pattern.test(source);
}

function stripPattern(source, pattern) {
  pattern.lastIndex = 0;
  return source.replace(pattern, '');
}

const errors = [];

for (const file of walk(cliSrc)) {
  const rel = relative(repoRoot, file);
  const source = readFileSync(file, 'utf8');

  checkImports(rel, source);

  if (!processInputAllowedFiles.has(rel)) {
    for (const { name, pattern } of processInputPatterns) {
      if (patternMatches(pattern, source)) {
        errors.push(
          `${rel}: ${name} must be read through runtime/cliContext.ts`,
        );
      }
    }
  }

  let outputSource = source;
  if (processTerminalInputAllowedFiles.has(rel)) {
    for (const { pattern } of processTerminalInputPatterns) {
      outputSource = stripPattern(outputSource, pattern);
    }
  }

  if (!processOutputAllowedFiles.has(rel)) {
    for (const { name, pattern } of processOutputPatterns) {
      if (patternMatches(pattern, outputSource)) {
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
