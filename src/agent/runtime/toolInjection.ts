import { Effect } from 'effect';

import type { StateReadFailed } from '@platform/interfaces';
import type { ProcessServices } from '@platform/processRuntime';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { RegisteredToolName } from '@tools/registry';
// Deliberately not the `@tools/goal` barrel: it also loads goalRows, whose
// session graph must not sit behind tool resolution (see the barrel's note).
import { isGoalEnabled } from '@tools/goal/goalFeatureFlag';
import { readSettingFrom } from '@utils/config/platformSettings';
import type { Runs } from './runRegistry';

/**
 * A tool that should be auto-injected into every tool-use agent's resolved
 * tool list when `shouldInject()` returns true. Used to keep agents from
 * having to opt into shared infrastructure (memory, goal) in YAML.
 *
 * The list every host ships is {@link AGENT_TOOL_INJECTIONS}; the tool
 * resolver iterates what it is handed and does not know which features exist.
 */
export interface ConditionalToolInjection {
  readonly toolName: RegisteredToolName;
  /** Whether the run resolving its tools, in the workspace whose settings
   *  slots `settings` are, gets this tool. */
  shouldInject(
    settings: SettingsStores,
  ): Effect.Effect<boolean, StateReadFailed>;
}

/**
 * The fixed injections every host ships. Each predicate reads its setting
 * when a run resolves its tools, from the settings slots of the run's own
 * workspace that it is handed: the goal flag from that workspace's
 * configuration, the memory setting through the catalog reader over the same
 * slots.
 */
export const AGENT_TOOL_INJECTIONS: readonly ConditionalToolInjection[] = [
  {
    toolName: 'memory',
    shouldInject: (settings) =>
      readSettingFrom<boolean>(settings, GlobalStateKey.MEMORY_ENABLED),
  },
  // The unified `plan` tool owns both planning and goal lifecycle commands
  // (update / pause / complete), so it is auto-injected whenever goal is
  // enabled: any tool-use agent can drive the autonomous loop without opting
  // into the tool in YAML.
  //
  // The goal continuation itself is not registered here: the tool-use loop
  // calls `maybeBuildGoalContinuation` directly at the pre-wait point. There
  // is no idle-continuation registry — goal was its only consumer.
  {
    toolName: 'plan',
    shouldInject: (settings) =>
      Effect.sync(() => isGoalEnabled(settings.config)),
  },
];

/**
 * The services every step of an agent run reads on the way down: the process
 * services (the global state store, the secret store, ...) and the `Runs` of the session the run is launched on.
 * Named once here because the launch, resume and delegation signatures all
 * carry exactly these tags in their `R` channel.
 */
export type AgentRunServices = ProcessServices | Runs;
