import { Context, Effect, Schema, type Scope } from 'effect';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import type { AgentCatalog } from '@agent/index/agentCatalog';
import { runInbox, type RunInbox } from '@agent/followUp/ToolUseFollowUp';
import { Inbox } from '@agent/followUp/Inbox';
import { getRunRecords } from '@agent/storage/runRecords';
import {
  launchChildAgent,
  type ChildLaunch,
} from '@agent/runtime/delegation/AgentTool';
import {
  launchProcessChild,
  type ProcessChildLaunch,
} from '@agent/runtime/processRun';
import type { PlatformServices } from '@platform/processRuntime';
import { SessionRoots, StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  qualifyAggregateId,
  type RunEnd,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import {
  Approvals,
  HistoryQuery,
  RunHistory,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import type { ToolAvailability } from '@tools/toolAvailabilityService';
import type { ToolRegistry } from '@tools/toolTable';

import { Runs } from './runRegistry';
import { Interactions } from './HostInteractions';
import { ProjectTools } from './loop/step';
import { SessionRequests, workAutoApproved } from './requests';
import type { RunCallShape } from './RunCall';
import type { RouteRetries } from './ModelRetryGate';
import type { SessionServices } from './rootLaunch';

/**
 * What a run's program requires of the process: the platform services every
 * process serves, the agent catalog, the plugin table its offered tools are
 * rebuilt from, each workspace's last dependency probe and the model routes'
 * retry gate. The composition's tool catalog (`ToolCatalog`) is not among
 * them: no run names it.
 */
export type RunServices =
  | PlatformServices
  | AgentCatalog
  | RouteRetries
  | ToolRegistry
  | ToolAvailability;

/** The services the runtime supplies to a tool's call, a plugin's and a
 *  built-in's alike: the process's, the rooted filesystems of the session
 *  the call works in, and the call (`ToolContext`, the run included). A
 *  tool takes `WorkspaceFs` from context instead of resolving a static
 *  against whichever roots its fiber happens to carry. The child-launch
 *  door (`ChildRuns`) and the call's place in its run (`RunCall`) are
 *  references with defaults, never requirements; a plugin's tool reads the
 *  door and never the session's `Runs`, which only the engine door carries
 *  (`RunCallShape.session`). */
export type PluginToolServices =
  | RunServices
  | ToolContext
  | WorkspaceFs
  | StorageFs
  | Scope.Scope;

/**
 * A plugin tool's one door to the session's runs. It launches children of
 * its call's run: an agent's (`launch`: the child's result, or its receipt
 * for a background launch) or an external process's (`launchProcess`: its
 * run id, outside the child-run budget); a plugin's tool reaches no other
 * launch. And it reaches a
 * run of the session by id: its input, live parent edge, records, whether
 * it holds a request, and the plugin's own facts on it. Each needs the
 * call's run; a standalone host call has none.
 */
export interface ChildRunsShape {
  readonly launch: (
    launch: ChildLaunch,
  ) => Effect.Effect<ToolResult, Error, PluginToolServices>;
  readonly launchProcess: (
    launch: ProcessChildLaunch,
  ) => Effect.Effect<RunId, Error, ToolContext | RunServices>;
  /** The run's input: what a tool sends it, and when it takes no more. */
  readonly inbox: (runId: RunId) => Effect.Effect<RunInbox, Error>;
  /** Its attached parent as the rows record it (`run.start`, then a
   *  `run.detach`): null for a root, or a run that is not there. */
  readonly parent: (runId: RunId) => Effect.Effect<RunId | null, Error>;
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
  /** Whether the launching run's work runs unasked (the Auto-approve policy,
   *  or an all-agent-work grant on it or an ancestor), read on each call,
   *  since a grant may land mid-run: what a child's own sandbox or
   *  permissions follow. */
  readonly autoApproved: Effect.Effect<boolean, Error>;
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
  autoApproved: noRun,
  requested: () => noRun,
});

/** The session's services, picked from its run's fiber: what each call's
 *  run carries (`RunCallShape.session`), which a built-in runs over and
 *  the doors a plugin's tool calls through ({@link childRuns}) provide. */
export const sessionServices = Effect.map(
  Effect.context<SessionServices>(),
  Context.pick(
    Runs,
    SessionLog,
    SessionViewAccess,
    Approvals,
    RunHistory,
    HistoryQuery,
    Inbox,
    Interactions,
    SessionRequests,
    ProjectTools,
    SessionRoots,
    WorkspaceFs,
    StorageFs,
  ),
);

/** The door, as the run loop provides it beside each call ({@link childRuns});
 *  outside a run it is the refusal, which is the reference's default. */
export const ChildRuns = Context.Reference<ChildRunsShape>(
  '@texra-ai/harness/agent/ChildRuns',
  { defaultValue: () => noRunChildRuns },
);

/** The door of one call: over the call's place in its run and the
 *  session's services, which the loop picked where it dispatched the call.
 *  A launch is provided those session services; its other requirements
 *  still resolve from the dispatching fiber. A plugin's tool sees neither. */
export const childRuns = (call: RunCallShape): ChildRunsShape => {
  const { session } = call;
  const { runId } = call.run;
  const log = Context.get(session, SessionLog);
  const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, session);
  return {
    launch: (launch) => inSession(launchChildAgent(launch)),
    launchProcess: (launch) =>
      inSession(launchProcessChild({ runId, logId: call.logId }, launch)),
    inbox: (id) => Effect.succeed(runInbox(id, session)),
    parent: (id) =>
      Effect.map(
        log.runRows(qualifyAggregateId('run', id), 'input'),
        (rows) => rows.parent?.id ?? null,
      ),
    records: (id) => ({
      exists: inSession(getRunRecords(id).exists()),
      end: inSession(getRunRecords(id).readRunEnd()),
    }),
    fact: (id, arm) =>
      Effect.map(log.facts(id), (held) => {
        const row = held?.facts[`${arm.plugin}/${arm.kind}`];
        return row === undefined
          ? undefined
          : Schema.decodeUnknownSync(arm.schema)(row.value);
      }),
    autoApproved: inSession(workAutoApproved(runId)),
    requested: (id, requestId) =>
      Effect.map(
        log.runRows(qualifyAggregateId('run', id), 'requests'),
        (rows) => rows.requests[requestId] !== undefined,
      ),
  };
};
