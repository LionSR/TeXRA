/**
 * TeXRA as a fake host's app (`TestApp`): its settings catalog, its plugins
 * over the host's setup platform, and its teams. A suite of
 * TeXRA's tools, settings or agents names it (`FakeHost.layer({ app:
 * TEXRA_APP })`); a suite of the harness alone runs over `HARNESS_APP`.
 */
import { Layer } from 'effect';

import { teamMembers } from '@texra/shared/agentTeams';
import { APP_FACT_KINDS } from '@texra/shared/plugins/appFactKinds';
import { DOCUMENT_TASK_BLOCK } from '@texra/shared/plugins/documents';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import { texraPlugins } from '@texra/tools/registry';
import type { Plugin } from '@tools/plugins';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import type { TestApp } from './FakePlatform';
import { FakeHost, SessionGraph } from './testKernel';

export const TEXRA_APP: TestApp = Object.freeze({
  settings: TEXRA_SETTINGS.catalog,
  plugins: (setup: SetupPlatformShape) =>
    texraPlugins({ name: 'vscode', setup }),
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
