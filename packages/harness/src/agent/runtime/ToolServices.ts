import { Context, Effect, Layer, type Scope } from 'effect';
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ToolContext } from '@agent/core/tools/ToolTypes';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import type { ToolResult } from '@shared/schemas';
import {
  launchChildAgent,
  type ChildLaunch,
} from '@tools/delegation/AgentTool';

import type { IssuingScript, RunCall, ScriptCalls } from './RunCall';
import type { Runs } from './runRegistry';

/** The runtime's services a call reads: the process's, the `Runs` of the
 *  session the call works in, the rooted filesystems of that same session,
 *  and the call (`ToolContext`, the run included). A tool takes
 *  `WorkspaceFs` from context instead of resolving a static against
 *  whichever roots its fiber happens to carry. */
type CallServices =
  ProcessServices | Runs | ToolContext | WorkspaceFs | StorageFs | Scope.Scope;

/**
 * A plugin tool's one door to launching a child agent from its call: the
 * child's settled result, or its receipt for a background launch. The
 * harness implements it over the call's own run and issuing script, so a
 * script's children share that script's concurrency budget.
 */
export class ChildRuns extends Context.Service<
  ChildRuns,
  {
    readonly launch: (
      launch: ChildLaunch,
    ) => Effect.Effect<ToolResult, Error, CallServices>;
  }
>()('@texra/agent/ChildRuns') {}

/** The harness's `ChildRuns`, over the call's place in its run and the
 *  script that issued it, which a built-in call provides: the launch reads
 *  them, the script's child budget included, and a plugin's tool never
 *  sees them. */
export const childRunsLayer: Layer.Layer<
  ChildRuns,
  never,
  RunCall | IssuingScript
> = Layer.effect(
  ChildRuns,
  Effect.map(Effect.context<RunCall | IssuingScript>(), (call) => ({
    launch: (launch: ChildLaunch) =>
      launchChildAgent(launch).pipe(Effect.provide(call)),
  })),
);

/** Services the runtime supplies to a plugin's tool: the call's, and the
 *  child-launch door. A plugin's tool may require its own plugin's services
 *  beside these (`definePlugin`); never the built-ins' call services. */
export type PluginToolServices = CallServices | ChildRuns;

/** What the runtime supplies to the harness's built-in tools: a plugin
 *  tool's services, and the call's place in its run and its script. */
export type ToolServices =
  PluginToolServices | RunCall | ScriptCalls | IssuingScript;
export type RuntimeTool<E = Error, R = ToolServices> = ITool<E, R>;
export type RuntimeToolRegistry = IToolRegistry<Error, ToolServices>;
