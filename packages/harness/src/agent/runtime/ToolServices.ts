import { Context, Effect, Schema, type Scope } from 'effect';
import { ToolContext } from '@tools/core/ToolTypes';
import { runInbox, type RunInbox } from '@agent/followUp/ToolUseFollowUp';
import { Inbox } from '@agent/followUp/Inbox';
import { getRunRecords } from '@agent/storage/runOwnership';
import {
  launchProcessChild,
  type ProcessChildLaunch,
} from '@agent/runtime/processRun';
import type { PlatformServices } from '@platform/processRuntime';
import { SessionRoots, StorageFs, WorkspaceFs } from '@platform/rootedFs';
import { type RunEnd, type RunId, factName } from '@shared/schemas';
import {
  Approvals,
  HistoryQuery,
  RunHistory,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import type { ToolAvailability } from '@tools/toolAvailabilityService';
import type { ToolRegistry } from '@tools/toolTable';

import { RunRegistry } from './runRegistry';
import { Interactions } from './HostInteractions';
import { ProjectTools } from './loop/step';
import { SessionRequests, workAutoApproved } from './requests';
import type { RunCallShape } from './RunCall';
import type { RouteRetries } from './ModelRetryGate';
import type { PlanQuotas } from './modelAccess/planQuotas';
import type { SessionServices } from './rootLaunch';

/**
 * What a run's program requires of the process: the platform services every
 * process serves, the plugin table its offered tools are
 * rebuilt from, each workspace's last dependency probe, the model routes'
 * retry gate and what is known of each plan's quota. The composition's tool catalog (`ToolCatalog`) is not among
 * them: no run names it.
 */
export type RunServices =
  | PlatformServices
  | RouteRetries
  | PlanQuotas
  | ToolRegistry
  | ToolAvailability;

/** The services the runtime supplies to a tool's call, a plugin's and a
 *  built-in's alike: the process's, the rooted filesystems of the session
 *  the call works in, the call (`ToolContext`, the run included) and its
 *  child-launch door (`ChildRuns`). A tool takes `WorkspaceFs` from context
 *  instead of resolving a static against whichever roots its fiber happens
 *  to carry. A plugin's tool reads the door and never the session's own
 *  services or the call's place in its run (`RunCall`), which only the
 *  harness's built-ins reach (`inRunSession`). */
export type PluginToolServices =
  | RunServices
  | ToolContext
  | ChildRuns
  | WorkspaceFs
  | StorageFs
  | Scope.Scope;

/**
 * A plugin tool's one door to the session's runs. It launches an external
 * process as a child of its call's run (`launchProcess`: its run id,
 * outside the child-run budget); a plugin's tool reaches no other launch.
 * And it reaches a run of the session by id: its input, its records and
 * the plugin's own facts on it, each over the call's run.
 */
export interface ChildRunsShape {
  readonly launchProcess: (
    launch: ProcessChildLaunch,
  ) => Effect.Effect<RunId, Error, ToolContext | RunServices>;
  /** The run's input: what a tool sends it, and when it takes no more. */
  readonly inbox: (runId: RunId) => Effect.Effect<RunInbox, Error>;
  /** Its records: whether the store still lists it, and its terminal
   *  result (null before it ends). */
  readonly records: (runId: RunId) => {
    readonly exists: Effect.Effect<boolean, Error>;
    readonly end: Effect.Effect<RunEnd | null, Error>;
  };
  /** The latest value of `factKind` among the run's own facts, decoded
   *  by its schema; undefined while the run recorded none. */
  readonly fact: <A>(
    runId: RunId,
    factKind: {
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
}

/** The session's services, picked from its run's fiber where the loop
 *  dispatches a response: what the doors a plugin's tool calls through
 *  ({@link childRuns}, its requests) run over. */
export const sessionServices = Effect.map(
  Effect.context<SessionServices>(),
  Context.pick(
    RunRegistry,
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

/** The door, as the run loop provides it beside each call ({@link childRuns}). */
export class ChildRuns extends Context.Service<ChildRuns, ChildRunsShape>()(
  '@texra-ai/harness/agent/ChildRuns',
) {}

/** The door of one call: over the call's place in its run and the
 *  session's services, which the loop picked where it dispatched the call.
 *  A launch is provided those session services; its other requirements
 *  still resolve from the dispatching fiber. A plugin's tool sees neither. */
export const childRuns = (
  call: RunCallShape,
  session: Context.Context<SessionServices>,
): ChildRunsShape => {
  const { runId } = call.run;
  const log = Context.get(session, SessionLog);
  const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, session);
  return {
    launchProcess: (launch) =>
      inSession(launchProcessChild({ runId, logId: call.logId }, launch)),
    inbox: (id) => Effect.succeed(runInbox(id, session)),
    records: (id) => ({
      exists: inSession(getRunRecords(id).exists()),
      end: inSession(getRunRecords(id).readRunEnd()),
    }),
    fact: (id, factKind) =>
      Effect.map(log.facts(id), (held) => {
        const row = held?.facts[factName(factKind)];
        return row === undefined
          ? undefined
          : Schema.decodeUnknownSync(factKind.schema)(row.value);
      }),
    autoApproved: inSession(workAutoApproved(runId)),
  };
};
