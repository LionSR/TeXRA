/**
 * TeXRA as a fake host's app (`TestApp`): its settings catalog and its
 * plugins (with no setup platform, as a host that passes none). A suite of
 * TeXRA's tools, settings or agents names it (`FakeHost.layer({ app:
 * TEXRA_APP })`); a suite of the harness alone runs over `HARNESS_APP`.
 */
import { Layer } from 'effect';

import { TEXRA_CLIENT } from '@texra/controllers/texraProcessLayer';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import { texraPlugins } from '@texra/tools/registry';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import type { TestApp } from './FakePlatform';
import { FakeHost, SessionGraph } from './testKernel';

export const TEXRA_APP: TestApp = Object.freeze({
  settings: TEXRA_SETTINGS.catalog,
  client: TEXRA_CLIENT,
  plugins: () => texraPlugins({ name: 'vscode' }),
});

/** `SessionGraph.hosted` over a default host running TeXRA. */
export const texraHosted = Layer.provideMerge(
  SessionGraph.layer,
  FakeHost.layer({ app: TEXRA_APP }),
);

/** The plugin table a store suite runs over: TeXRA's plugins own no row
 *  kind, and a store reads no tool. */
export const storePluginsLayer = Layer.succeed(ToolRegistry)(toolTable([]));
