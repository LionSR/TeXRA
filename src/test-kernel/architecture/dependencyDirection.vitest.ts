// Node imports
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

/**
 * Architecture ratchet: the platform-independent ("VS Code-free") source zones
 * must never import the `vscode` module. They reach host services through
 * `platform()` / host adapters instead (see CLAUDE.md "Separation of Concerns").
 *
 * This duplicates the guard already enforced by the `local/no-vscode-import-in-
 * free-zones` ESLint rule, on purpose: a stray `// eslint-disable` line can
 * silently neuter the lint rule, but it cannot bypass a test in the `npm test`
 * gate. The two layers are independent on purpose — if you add a zone here, add
 * it to `VSCODE_FREE_ZONE_DIRS` in `eslint.config.mjs` too (and vice versa).
 */

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

// Keep in sync with `VSCODE_FREE_ZONE_DIRS` in eslint.config.mjs.
const VSCODE_FREE_ZONES = [
  'src/agent',
  'src/model',
  'src/latex',
  'src/tools',
  'src/controllers',
  'src/shared',
  'src/replacement',
  'src/eventBus',
  'src/hosts',
  'packages/extension/src/webview/frontend',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
] as const;

const SOURCE_FILE = /\.(?:ts|tsx|mts)$/;

// `import … from 'vscode'` / `export … from 'vscode'`, CommonJS `require('vscode')`
// (incl. `import x = require('vscode')`), and dynamic `import('vscode')`.
const VSCODE_IMPORT_PATTERNS = [
  /\bfrom\s+['"]vscode['"]/,
  /\brequire\s*\(\s*['"]vscode['"]\s*\)/,
  /\bimport\s*\(\s*['"]vscode['"]\s*\)/,
];

const AGENT_IMPORT_PATTERNS = [
  /\bfrom\s+['"]@agent\//,
  /\brequire\s*\(\s*['"]@agent\//,
  /\bimport\s*\(\s*['"]@agent\//,
];

const SHARED_AGENT_IMPORT_ALLOWLIST = [
  // Existing pre-relocation edge. Keep this list fixed unless the edge is
  // deleted; new shared-to-agent imports would recreate the moved inversion.
  'src/shared/agent/terminalResultPresentation.ts',
] as const;
const SHARED_AGENT_IMPORT_ALLOWLIST_SET = new Set<string>(
  SHARED_AGENT_IMPORT_ALLOWLIST,
);

/** Drop comments so a prose mention like "do not import from 'vscode'" can't
 *  trip the import patterns. Naive `//` stripping is fine here: a real import
 *  precedes any trailing comment, and cutting mid-string only matters on lines
 *  that never contain a `vscode` import anyway. */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const commentStart = line.indexOf('//');
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join('\n');
}

function sourceFilesUnder(zone: string): string[] {
  const absoluteZone = resolve(REPO_ROOT, zone);
  let entries: string[];
  try {
    entries = readdirSync(absoluteZone, { recursive: true }) as string[];
  } catch {
    // A renamed/removed zone surfaces as the file-count guard below failing,
    // not as a silently green ratchet.
    return [];
  }
  return entries
    .filter((rel) => SOURCE_FILE.test(rel) && !rel.endsWith('.d.ts'))
    .map((rel) => join(absoluteZone, rel));
}

function importsVscode(file: string): boolean {
  const source = stripComments(readFileSync(file, 'utf8'));
  return VSCODE_IMPORT_PATTERNS.some((pattern) => pattern.test(source));
}

function importsAgent(file: string): boolean {
  const source = stripComments(readFileSync(file, 'utf8'));
  return AGENT_IMPORT_PATTERNS.some((pattern) => pattern.test(source));
}

describe('VS Code-free zones never import vscode', () => {
  for (const zone of VSCODE_FREE_ZONES) {
    it(`${zone} has no vscode imports`, () => {
      const offenders = sourceFilesUnder(zone)
        .filter(importsVscode)
        .map((file) => relative(REPO_ROOT, file));
      expect(offenders).toEqual([]);
    });
  }

  it('actually scans the zones (guards against a broken file walk)', () => {
    const scanned = VSCODE_FREE_ZONES.reduce(
      (total, zone) => total + sourceFilesUnder(zone).length,
      0,
    );
    expect(scanned).toBeGreaterThan(100);
  });
});

describe('Shared layer dependency direction', () => {
  it('does not grow shared-to-agent imports', () => {
    const offenders = sourceFilesUnder('src/shared')
      .filter(importsAgent)
      .map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/'))
      .filter((file) => !SHARED_AGENT_IMPORT_ALLOWLIST_SET.has(file))
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
