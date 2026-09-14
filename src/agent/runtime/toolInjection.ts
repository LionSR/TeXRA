import { Context, Layer } from 'effect';

import type { ConfigProvider } from '@platform/interfaces';
import type { ProcessServices } from '@platform/processRuntime';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { RegisteredToolName } from '@tools/registry';
// Deliberately not the `@tools/goal` barrel: it also loads goalRows, whose
// session graph must not sit behind tool resolution (see the barrel's note).
import { isGoalEnabled } from '@tools/goal/goalFeatureFlag';
import { readPlatformSetting } from '@utils/config/platformSettings';

/**
 * A tool that should be auto-injected into every tool-use agent's resolved
 * tool list when `shouldInject()` returns true. Used to keep agents from
 * having to opt into shared infrastructure (memory, goal) in YAML.
 *
 * The process's list is {@link AGENT_TOOL_INJECTIONS}, provided as
 * {@link ToolInjections}; core flow code iterates what it is handed and does
 * not know which features exist.
 */
export interface ConditionalToolInjection {
  readonly toolName: RegisteredToolName;
  /** Whether the run resolving its tools, in the workspace `config` is the
   *  configuration of, gets this tool. */
  shouldInject(config: ConfigProvider): boolean;
}

/**
 * A caller-owned list for a flow or suite that resolves tools with its own
 * injections instead of the process's (the reflection flow injects none).
 */
export class ToolInjectionRegistry {
  private readonly injections: ConditionalToolInjection[] = [];

  register(injection: ConditionalToolInjection): void {
    if (this.injections.some((i) => i.toolName === injection.toolName)) {
      throw new Error(
        `Duplicate conditional tool injection: ${injection.toolName}`,
      );
    }
    this.injections.push(injection);
  }

  list(): readonly ConditionalToolInjection[] {
    return [...this.injections];
  }
}

/**
 * The fixed injections every host ships. Each predicate reads its setting
 * when a run resolves its tools: the goal flag from the run's workspace
 * configuration it is handed, the memory setting through the catalog reader
 * (so `initPlatform()` and the process workspace roots must be initialized
 * by then).
 */
export const AGENT_TOOL_INJECTIONS: readonly ConditionalToolInjection[] = [
  {
    toolName: 'memory',
    shouldInject: () =>
      readPlatformSetting<boolean>(GlobalStateKey.MEMORY_ENABLED),
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
    shouldInject: (config) => isGoalEnabled(config),
  },
];

/**
 * The process's conditional tool injections as an Effect service
 * (`@texra/agent/ToolInjections`, injection plan §5 row 14): the resolved
 * list, provided once by `installProcessRuntime`. Replaces the module-level
 * registry the roots used to register into at startup.
 */
export class ToolInjections extends Context.Service<
  ToolInjections,
  { readonly list: () => readonly ConditionalToolInjection[] }
>()('@texra/agent/ToolInjections') {
  static layer(
    injections: readonly ConditionalToolInjection[],
  ): Layer.Layer<ToolInjections> {
    return Layer.succeed(ToolInjections)({ list: () => injections });
  }
}

/**
 * The process services every step of an agent run reads on the way down: the
 * conditional tool injections, the global state store and the secret store.
 * Named once here because the launch, resume and delegation signatures all
 * carry exactly these three tags in their `R` channel.
 */
export type AgentRunServices = ProcessServices;
