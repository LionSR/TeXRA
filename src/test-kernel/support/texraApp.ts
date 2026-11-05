/**
 * TeXRA as a fake host's app (`TestApp`): its settings catalog, its plugins
 * over the installed host's setup platform, and its teams. A suite of
 * TeXRA's tools, settings or agents names it (`FakeHost.layer({ app:
 * TEXRA_APP })`); a suite of the harness alone runs over `HARNESS_APP`.
 */
import { Layer } from 'effect';

import { teamMembers } from '@texra/shared/agentTeams';
import { APP_FACT_KINDS } from '@texra/shared/plugins/appFactKinds';
import { DOCUMENT_TASK_BLOCK } from '@texra/shared/plugins/documents';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import { texraPlugins } from '@texra/tools/registry';
import type { Plugin } from '@tools/plugins';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import type { TestApp } from './FakePlatform';
import { installedHost } from './setupPlatform';
import { FakeHost, SessionGraph } from './testKernel';

/**
 * The setup platform of every test's TeXRA plugin list: each member reads
 * the installed host's `setup` when called, so a suite that swaps hosts per
 * test swaps setup platforms with them. A host without one has none of its
 * members, as a host that passes no setup platform.
 */
export const fakeSetupPlatform: SetupPlatformShape = {
  get commands() {
    return installedHost().setup?.commands;
  },
  get extensions() {
    return installedHost().setup?.extensions;
  },
  get terminal() {
    return installedHost().setup?.terminal;
  },
};

export const TEXRA_APP: TestApp = Object.freeze({
  settings: TEXRA_SETTINGS.catalog,
  plugins: () => texraPlugins({ name: 'vscode', setup: fakeSetupPlatform }),
  teamMembers,
});

/** `SessionGraph.hosted` over a default host running TeXRA. */
export const texraHosted = Layer.provideMerge(
  SessionGraph.layer,
  FakeHost.layer({ app: TEXRA_APP }),
);

/** TeXRA's plugins that own row kinds or an agent-file block, as those
 *  only: what a store under test reads their rows with, and a catalog under
 *  test scans the bundled agents with. */
const FACT_KIND_PLUGINS: readonly Plugin[] = [
  {
    id: 'documents',
    factKinds: APP_FACT_KINDS.documents,
    agentBlock: DOCUMENT_TASK_BLOCK,
  },
  { id: 'external-inquiry', factKinds: APP_FACT_KINDS['external-inquiry'] },
];

/** The plugin table a store or catalog suite runs over: every row kind and
 *  agent-file block TeXRA's plugins own, and no tool. */
export const storePluginsLayer = Layer.succeed(ToolRegistry)(
  toolTable([...FACT_KIND_PLUGINS]),
);
