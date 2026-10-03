/**
 * What a resume of a run waits for in this process (durable harness, gap 2
 * and D5): its agent is missing from the catalog, or its agent comes from an
 * installed plugin that is off or not trusted as it is now. A resume that
 * meets one does not fail the run: the run stays interrupted, the reason
 * goes into the projection (`SessionHandle.markResumeBlocked`), and the
 * session's follower (`followInterruptedTasks`) resumes it once the catalog
 * says it is back.
 *
 * A tool plugin that is off is not a blocker: the step withholds its tools,
 * and a call to one settles `tool_unavailable` (the user's switch, not the
 * agent's file).
 */
import { Effect, type FileSystem } from 'effect';

import { refresh, resolveAgentForLaunch, settledCatalog } from '@agent/index';
import type { AgentCatalogLoadError } from '@agent/index/agentRegistry';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { readInstalledPluginLoad } from '@common/plugins/pluginTrust';
import type { StateReadFailed } from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import { agentName, type ResumeBlocker } from '@shared/schemas';

import type { SessionHandle } from './SessionHandle';

/** What blocks resuming a run of `config` here, or null when nothing does. */
export const resumeBlocker = Effect.fn('resumeBlocker')(function* (
  session: SessionHandle,
  config: Pick<AgentConfig, 'agent' | 'agentCategory' | 'agentSource'>,
): Effect.fn.Return<
  ResumeBlocker | null,
  AgentCatalogLoadError | StateReadFailed,
  AgentCatalogServices | FileSystem.FileSystem
> {
  // The launch's own resolution: the settled catalog, rescanned once on a
  // miss, so an agent saved a moment ago is found.
  const resolve = resolveAgentForLaunch(
    session.roots,
    config.agentCategory,
    config.agent,
    config.agentSource,
  );
  yield* settledCatalog;
  const entry = (yield* resolve) ?? (yield* Effect.andThen(refresh(), resolve));
  // The catalog lists a plugin's agents only while the plugin loads, so a
  // plugin agent it misses is answered by the plugin's install record.
  // A launch may record the source-qualified spelling (`plugin:acme:x`).
  const name = entry?.name ?? agentName(config.agent);
  const pluginAgent =
    entry != null ? entry.source === 'plugin' : config.agentSource === 'plugin';
  if (!pluginAgent)
    return entry == null ? { kind: 'agentMissing', name: config.agent } : null;
  const plugin = name.slice(0, name.indexOf(':'));
  const load = yield* readInstalledPluginLoad(session.roots);
  if (load.loadable.some(({ record }) => record.name === plugin)) return null;
  // A plugin trust withholds names itself; any other is off or gone.
  return load.withheld.some((reason) => reason.startsWith(`Plugin ${plugin} `))
    ? { kind: 'pluginUntrusted', name: plugin }
    : { kind: 'pluginOff', name: plugin };
});
