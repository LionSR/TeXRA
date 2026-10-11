import { Context, Effect, Layer, type Scope } from 'effect';
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ToolContext } from '@agent/core/tools/ToolTypes';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import type { ToolResult } from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import {
  launchChildAgent,
  type ChildLaunch,
} from '@tools/delegation/AgentTool';
import {
  launchProcessChild,
  type ProcessChildLaunch,
} from '@tools/delegation/detachedChildRun';

import { RunCall, type IssuingScript, type ScriptCalls } from './RunCall';
import type { Runs } from './runRegistry';

/** The runtime's services a call reads: the process's, the rooted
 *  filesystems of the session the call works in, and the call
 *  (`ToolContext`, the run included). A tool takes `WorkspaceFs` from
 *  context instead of resolving a static against whichever roots its fiber
 *  happens to carry. */
type CallServices =
  ProcessServices | ToolContext | WorkspaceFs | StorageFs | Scope.Scope;

/**
 * A plugin tool's one door to the session's runs, all children of its
 * call's run: an agent's (`launch`: the child's settled result, or its
 * receipt for a background launch, within the issuing script's concurrency
 * budget) or an external process's (`launchProcess`: its run id, outside
 * the budget). A plugin's tool reaches no other launch.
 */
export class ChildRuns extends Context.Service<
  ChildRuns,
  {
    readonly launch: (
      launch: ChildLaunch,
    ) => Effect.Effect<ToolResult, Error, CallServices>;
    readonly launchProcess: <TTurn>(
      launch: ProcessChildLaunch<TTurn>,
    ) => Effect.Effect<RunId, Error>;
  }
>()('@texra/agent/ChildRuns') {}

/** The harness's `ChildRuns`, over the session's runs, the call's place in
 *  its run and the script that issued it, which a built-in call provides:
 *  the launch reads them, the script's child budget included, and a
 *  plugin's tool never sees them. */
export const childRunsLayer: Layer.Layer<
  ChildRuns,
  never,
  RunCall | IssuingScript | Runs
> = Layer.effect(
  ChildRuns,
  Effect.map(Effect.context<RunCall | IssuingScript | Runs>(), (call) => ({
    launch: (launch: ChildLaunch) =>
      launchChildAgent(launch).pipe(Effect.provide(call)),
    launchProcess: <TTurn>(launch: ProcessChildLaunch<TTurn>) =>
      Effect.gen(function* () {
        const runCall = yield* RunCall;
        if (runCall === null)
          return yield* Effect.fail(
            new Error('A process child needs a run to be launched under.'),
          );
        const { session, runId } = runCall.run;
        return yield* launchProcessChild(session, runId, launch);
      }).pipe(Effect.provide(call)),
  })),
);

/** Services the runtime supplies to a plugin's tool: the call's, and the
 *  child-launch door. A plugin's tool may require its own plugin's services
 *  beside these (`definePlugin`); never the built-ins' call services, nor
 *  the session's `Runs`. */
export type PluginToolServices = CallServices | ChildRuns;

/** What the runtime supplies to the harness's built-in tools: a plugin
 *  tool's services, the session's runs, and the call's place in its run
 *  and its script. */
export type ToolServices =
  PluginToolServices | Runs | RunCall | ScriptCalls | IssuingScript;
export type RuntimeTool<E = Error, R = ToolServices> = ITool<E, R>;
export type RuntimeToolRegistry = IToolRegistry<Error, ToolServices>;
