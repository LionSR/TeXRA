import { Context, Effect, Schema, type Scope } from 'effect';
import type { ITool, ToolContext } from '@agent/core/tools/ToolTypes';
import { runInbox, type RunInbox } from '@agent/followUp/ToolUseFollowUp';
import { getRunRecords } from '@agent/storage/runRecords';
import {
  launchChildAgent,
  type ChildLaunch,
} from '@agent/runtime/delegation/AgentTool';
import {
  launchProcessChild,
  type ProcessChildLaunch,
} from '@agent/runtime/delegation/detachedChildRun';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  qualifyAggregateId,
  type RunEnd,
  type RunId,
  type ToolResult,
} from '@shared/schemas';

import { Runs } from './runRegistry';
import type { RunCallShape } from './RunCall';

/** The runtime's services a call reads: the process's, the rooted
 *  filesystems of the session the call works in, and the call
 *  (`ToolContext`, the run included). A tool takes `WorkspaceFs` from
 *  context instead of resolving a static against whichever roots its fiber
 *  happens to carry. */
export type CallServices =
  ProcessServices | ToolContext | WorkspaceFs | StorageFs | Scope.Scope;

/**
 * A plugin tool's one door to the session's runs. It launches children of
 * its call's run: an agent's (`launch`: the child's settled result, or its
 * receipt for a background launch, within the issuing script's concurrency
 * budget) or an external process's (`launchProcess`: its run id, outside
 * the budget); a plugin's tool reaches no other launch. And it reaches a
 * run of the session by id: its input, live parent edge, records, whether
 * it holds a request, and the plugin's own facts on it. Each needs the
 * call's run; a standalone host call has none.
 */
export interface ChildRunsShape {
  readonly launch: (
    launch: ChildLaunch,
  ) => Effect.Effect<ToolResult, Error, CallServices>;
  readonly launchProcess: <TTurn>(
    launch: ProcessChildLaunch<TTurn>,
  ) => Effect.Effect<RunId, Error>;
  /** The run's input: what a tool sends it, and when it takes no more. */
  readonly inbox: (runId: RunId) => Effect.Effect<RunInbox, Error>;
  /** Its parent while it is live in this process: null for a root run,
   *  undefined when it is not live here. */
  readonly parent: (
    runId: RunId,
  ) => Effect.Effect<RunId | null | undefined, Error>;
  /** Its records: whether the store still lists it, and its terminal
   *  result (null before it ends). */
  readonly records: (runId: RunId) => {
    readonly exists: Effect.Effect<boolean, Error>;
    readonly end: Effect.Effect<RunEnd | null, Error>;
  };
  /** The latest value of `arm`'s kind among the run's own facts, decoded
   *  by the arm's schema; undefined while the run recorded none. */
  readonly fact: <A>(
    runId: RunId,
    arm: {
      readonly plugin: string;
      readonly kind: string;
      readonly schema: Schema.Codec<A, unknown>;
    },
  ) => Effect.Effect<A | undefined, Error>;
  /** Whether the run holds the request `requestId`, open or decided: what
   *  a tool that posted one reads after a failed post. */
  readonly requested: (
    runId: RunId,
    requestId: string,
  ) => Effect.Effect<boolean, Error>;
}

const noRun = Effect.fail(
  new Error('This call is under no run, so it launches and reads none.'),
);

/** The door outside a run (a host's standalone call): every door refuses.
 *  One frozen value, handed to every standalone caller. */
const noRunChildRuns: ChildRunsShape = Object.freeze({
  launch: () => noRun,
  launchProcess: () => noRun,
  inbox: () => noRun,
  parent: () => noRun,
  records: () => ({ exists: noRun, end: noRun }),
  fact: () => noRun,
  requested: () => noRun,
});

/** The door, as the run loop provides it beside each call ({@link childRuns});
 *  outside a run it is the refusal, which is the reference's default. */
export const ChildRuns = Context.Reference<ChildRunsShape>(
  '@texra-ai/harness/agent/ChildRuns',
  { defaultValue: () => noRunChildRuns },
);

/** The door of one call: over the call's place in its run and the
 *  session's runs, which the loop read where it dispatched the call. A
 *  launch runs under exactly those, so nothing of the dispatching fiber's
 *  context reaches it, and a plugin's tool sees neither. */
export const childRuns = (
  call: RunCallShape,
  runs: Runs['Service'],
): ChildRunsShape => {
  const { session, runId } = call.run;
  return {
    launch: (launch) =>
      launchChildAgent(launch).pipe(Effect.provideService(Runs, runs)),
    launchProcess: (launch) =>
      launchProcessChild(session, runId, launch).pipe(
        Effect.provideService(Runs, runs),
      ),
    inbox: (id) => Effect.succeed(runInbox(session, id)),
    parent: (id) => Effect.succeed(session.runs.get(id)?.parent),
    records: (id) => ({
      exists: getRunRecords(session, id).exists(),
      end: getRunRecords(session, id).readRunEnd(),
    }),
    fact: (id, arm) =>
      Effect.map(session.log.facts(id), (held) => {
        const row = held?.facts[`${arm.plugin}/${arm.kind}`];
        return row === undefined
          ? undefined
          : Schema.decodeUnknownSync(arm.schema)(row.value);
      }),
    requested: (id, requestId) =>
      Effect.map(
        session.log.runRows(qualifyAggregateId('run', id), 'requests'),
        (rows) => rows.requests[requestId] !== undefined,
      ),
  };
};

/** Services the runtime supplies to a plugin's tool: the call's. The
 *  child-launch door (`ChildRuns`) and the call's place in its run
 *  (`RunCall`) are references with defaults, never requirements; a plugin's
 *  tool reads the door and never the session's `Runs`. */
export type PluginToolServices = CallServices;

/** What the runtime supplies to the harness's built-in tools: a plugin
 *  tool's services and the session's runs. */
export type ToolServices = PluginToolServices | Runs;
export type RuntimeTool<E = Error, R = ToolServices> = ITool<E, R>;
/** The tools a run offers, by name. */
export type RuntimeToolRegistry = ReadonlyMap<string, RuntimeTool>;
