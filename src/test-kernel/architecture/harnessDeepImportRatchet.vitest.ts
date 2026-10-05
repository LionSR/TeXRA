// The harness deep-import ratchet (split design §4, ruling SQ2). The app
// (packages/texra), the hosts (cli, desktop, extension) and the trace viewer
// should reach the harness only through its package name and subpaths
// (`@texra-ai/harness`, `/node`, `/plugins`, `/schemas`). Each `@agent/*`,
// `@platform/*`, `@shared/*` … specifier they import instead pins a
// harness-internal module from outside it. The baseline is each package's
// exact set of DISTINCT harness-internal specifiers, and it only shrinks: a
// live specifier absent from the baseline is a new edge, and a baseline
// specifier with no live import is stale headroom that could absorb a future
// edge. Remove a deep import by giving the symbol a documented public export
// with a consumer, or by moving the module to the package that owns it; then
// shrink config/ratchets/harness-deep-import-baseline.json.

// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  collectModuleSpecifiers,
  parseSourceFile,
  REPO_ROOT,
  sourceFilesUnder,
} from '../support/repoScan';

const PACKAGES = [
  'cli',
  'desktop',
  'extension',
  'texra',
  'trace-viewer',
] as const;

type Package = (typeof PACKAGES)[number];

interface DeepImportBaseline {
  semantics: string;
  hosts: Record<Package, string[]>;
}

const BASELINE_FILE = 'config/ratchets/harness-deep-import-baseline.json';
const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_FILE);
const TSCONFIG_PATH = resolve(REPO_ROOT, 'tsconfig.json');

/** Each tsconfig alias (`@agent`, `@transcript`, `@common/webview`, …) and
 *  whether it names a harness-internal path, read from the one source of
 *  truth. The package's own entries (`@texra-ai/harness`, `/node`, …) are
 *  its public surface, not deep imports. */
function loadAliases(): ReadonlyMap<string, boolean> {
  const parsed = ts.parseConfigFileTextToJson(
    TSCONFIG_PATH,
    readFileSync(TSCONFIG_PATH, 'utf8'),
  );
  if (parsed.error != null) {
    throw new Error(`Cannot parse tsconfig.json: ${parsed.error.messageText}`);
  }
  const paths = parsed.config?.compilerOptions?.paths as
    Record<string, string[]> | undefined;
  return new Map(
    Object.entries(paths ?? {}).map(([key, targets]) => [
      key.replace(/\/\*$/, ''),
      !key.startsWith('@texra-ai/') &&
        targets[0]?.startsWith('./packages/harness/src/') === true,
    ]),
  );
}

const ALIASES = loadAliases();

/** Whether `specifier`'s longest matching alias is a harness one, so the
 *  extension's own `@common/webview` is not read as the harness's `@common`. */
function isHarnessDeepImport(specifier: string): boolean {
  const alias = [...ALIASES.keys()]
    .filter((key) => specifier === key || specifier.startsWith(`${key}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  return alias !== undefined && ALIASES.get(alias) === true;
}

function liveSpecifiers(pkg: Package): string[] {
  const specifiers = new Set<string>();
  for (const file of sourceFilesUnder(
    resolve(REPO_ROOT, `packages/${pkg}/src`),
  )) {
    for (const specifier of collectModuleSpecifiers(parseSourceFile(file))) {
      if (isHarnessDeepImport(specifier)) specifiers.add(specifier);
    }
  }
  return [...specifiers].toSorted((a, b) => a.localeCompare(b));
}

function readBaseline(): DeepImportBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as DeepImportBaseline;
}

describe('harness deep-import ratchet', () => {
  // Scanned once: the cases read the same snapshot.
  const baseline = readBaseline();
  const current = Object.fromEntries(
    PACKAGES.map((pkg) => [pkg, liveSpecifiers(pkg)]),
  ) as Record<Package, string[]>;

  it.each(PACKAGES)(
    'rejects a harness-internal specifier in %s that is not in the baseline',
    (pkg) => {
      const listed = new Set(baseline.hosts[pkg]);
      const added = current[pkg].filter((specifier) => !listed.has(specifier));
      expect(
        added,
        `New ${pkg} harness deep import(s) not in ${BASELINE_FILE}:\n` +
          added.map((specifier) => `  + ${specifier}`).join('\n') +
          `\n\nImport the public entry (@texra-ai/harness and its subpaths) or move the module to its owner; do not widen ${BASELINE_FILE}.`,
      ).toEqual([]);
    },
  );

  it.each(PACKAGES)(
    'rejects baseline specifiers with no live %s import (stale headroom)',
    (pkg) => {
      const live = new Set(current[pkg]);
      const stale = baseline.hosts[pkg].filter(
        (specifier) => !live.has(specifier),
      );
      expect(
        stale,
        `Stale ${pkg} specifier(s) in ${BASELINE_FILE}:\n` +
          stale.map((specifier) => `  - ${specifier}`).join('\n') +
          `\n\nRemove them from ${BASELINE_FILE} so they cannot absorb a future new edge.`,
      ).toEqual([]);
    },
  );

  it('keeps the baseline ordered and duplicate-free per package', () => {
    for (const pkg of PACKAGES) {
      const sortedUnique = [...new Set(baseline.hosts[pkg])].toSorted((a, b) =>
        a.localeCompare(b),
      );
      expect(baseline.hosts[pkg], `${BASELINE_FILE} hosts.${pkg}`).toEqual(
        sortedUnique,
      );
    }
  });
});
