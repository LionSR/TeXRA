// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  ALL_HOST_PRODUCTION_ROOTS,
  collectModuleSpecifiers,
  expectRealCoverage,
  parseSourceFile,
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

/**
 * Invariants 1 and 6 of the core concepts, for what a plugin brings: its
 * own row kinds (`PLUGIN_EVENT_ARMS`) and its services (`PLUGIN_PROCESS_LAYERS`,
 * `PLUGIN_SESSION_LAYERS`). Failure modes guarded:
 *
 * - core (`src/shared`, `src/agent`) imports a plugin's arm, so a plugin's
 *   row kind is hard-coded in core again and a new stateful plugin edits
 *   core;
 * - a plugin row is drafted anywhere but its plugin's arm module, or a
 *   plugin reaches the store's append port, so a second append path or a
 *   row no arm checks appears;
 * - a plugin's service is reached outside its own plugin's code, which the
 *   step serves it to, and the one host door (the settings Git tab reading
 *   the GitHub plugin's process services through `LiveTools`), so plugin
 *   state is used past its switch and its pin. `PluginServices` is also
 *   kept out of `ProcessServices` at compile time (`processRuntime.ts`).
 */
const PLUGIN_ARM_MODULES = /^src\/shared\/plugins\//;
const PLUGIN_ARM_IMPORT = /^@shared\/plugins\/|^@tools\/pluginArms$/;
const CORE = /^src\/(?:shared|agent)\//;
const APPEND_PORTS =
  /^@(?:controllers\/session\/Database|shared\/session\/database|agent\/runtime\/SessionEvents)$/;
const PLUGIN_ROW = /type:\s*'plugin\.fact'/;

/** Each plugin service and the files that may reach it. */
const PLUGIN_SERVICES: readonly {
  readonly tag: string;
  readonly users: RegExp;
}[] = [
  {
    tag: 'GitHubSubscriptions',
    users:
      /^src\/tools\/(?:github\/|registry\.ts$)|^src\/controllers\/settingsView\/githubSubscriptions\.ts$/,
  },
  { tag: 'CodexThreads', users: /^src\/tools\/codex\.ts$/ },
  { tag: 'ClaudeAgentSessions', users: /^src\/tools\/claudeAgent\.ts$/ },
];
/** Where the services are declared, typed and built. */
const SERVICE_HOMES = new Set([
  'src/tools/agentCliSessionStores.ts',
  'src/tools/registry.ts',
  'src/platform/processRuntime.ts',
]);

const files = () => ALL_HOST_PRODUCTION_ROOTS.flatMap(productionFilesUnder);
const source = (file: string) =>
  stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
const specifiers = (file: string) =>
  collectModuleSpecifiers(parseSourceFile(resolve(REPO_ROOT, file)));

describe('plugin boundaries (invariants 1 and 6)', () => {
  it('keeps plugin arms out of core', () => {
    const offenders = files()
      .filter((file) => CORE.test(file) && !PLUGIN_ARM_MODULES.test(file))
      .filter((file) =>
        specifiers(file).some((s) => PLUGIN_ARM_IMPORT.test(s)),
      );
    expect(offenders).toEqual([]);
  });

  it('drafts plugin rows only in arm modules, which reach no append port', () => {
    const drafts = files()
      .filter((file) => !PLUGIN_ARM_MODULES.test(file))
      .filter((file) => PLUGIN_ROW.test(source(file)));
    const appends = files()
      .filter((file) => PLUGIN_ARM_MODULES.test(file))
      .filter((file) => specifiers(file).some((s) => APPEND_PORTS.test(s)));
    expect({ drafts, appends }).toEqual({ drafts: [], appends: [] });
  });

  it('reaches plugin services only from their plugin and the step', () => {
    const offenders = PLUGIN_SERVICES.flatMap(({ tag, users }) =>
      files()
        .filter((file) => !users.test(file) && !SERVICE_HOMES.has(file))
        .filter((file) => new RegExp(`\\b${tag}\\b`).test(source(file)))
        .map((file) => `${file} reaches ${tag}`),
    );
    expect(offenders).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});
