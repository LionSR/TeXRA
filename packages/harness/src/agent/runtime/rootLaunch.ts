import { Context, Deferred, Effect, Fiber, SubscriptionRef } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { Inbox } from '@agent/followUp/ToolUseFollowUp';
import {
  SessionRoots,
  type StorageFs,
  type WorkspaceFs,
} from '@platform/rootedFs';
import {
  APPROVAL_BYPASS_KINDS,
  inheritedGrants,
  NO_APPROVAL_GRANTS,
  type ApprovalPolicyLimit,
} from '@shared/approvalBypassKind';
import type { CommitOrdinal, RunId, SessionCloseReport } from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';
import type { StartOptionsSchema } from '@shared/session/runtimeRequest';
import {
  type Approvals,
  SessionViewAccess,
  type HistoryQuery,
  type RunHistory,
  type SessionLog,
} from '@shared/session/runHistory';
import { humanGrant } from './runApprovalQueue';
import {
  activationIfOpened,
  prepareAgentDefinition,
} from './AgentLaunchContext';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { applyHelperModelPreference } from './helperModelName';
import { registryOf, Runs } from './runRegistry';
import type { SessionHandleInit } from './SessionHandle';
import type { Interactions } from './HostInteractions';
import type { ProjectTools } from './loop/step';
import type { SessionRequests } from './requestPolicy';

/**
 * A session's own services: each owner its layer built (`sessionOwners.ts`),
 * which its runs, its requests and the SDK's reads of it take from context.
 */
export type SessionServices =
  | Runs
  | SessionLog
  | SessionViewAccess
  | Approvals
  | RunHistory
  | HistoryQuery
  | Inbox
  | Interactions
  | SessionRequests
  | ProjectTools
  | SessionRoots
  | WorkspaceFs
  | StorageFs;

/** The process's session owner: one session per workspace storage root,
 *  served by `processLayer` over the `LayerMap` that owns every session's
 *  lifetime. Every opener (the hosts' default sessions, the desktop's
 *  projects, the service's tasks, the SDK's `Sessions`) reaches it from
 *  context. The session `open` returns (its services, as a context) is
 *  borrowed access with no disposal obligation: `close` is how a session
 *  ends, and the process layer's own release closes whatever is still
 *  open. */
export class SessionOwner extends Context.Service<
  SessionOwner,
  {
    /** The session of `init.roots`' storage root: the one already open
     *  there, or built now over `init`, which is read only then: a later
     *  opener of the same root gets the session the first one built. */
    readonly open: (
      init: SessionHandleInit,
    ) => Effect.Effect<Context.Context<SessionServices>, SessionOpenError>;
    /** Every session the owner holds, waiting within the close budget. */
    readonly list: Effect.Effect<readonly Context.Context<SessionServices>[]>;
    /** Whether it still holds the session of `root` whose runs are `runs`:
     *  that root's entry, never another's. */
    readonly holds: (
      root: string,
      runs: Runs['Service'],
    ) => Effect.Effect<boolean>;
    /** Close a storage root's session: refuse new runs, stop its own ones
     *  and wait inside `SESSION_CLOSE_DEADLINE_MS`, report those still
     *  live abandoned, flush, release. A root with no open session reports
     *  `settled`. Never touches another root's session. */
    readonly close: (root: string) => Effect.Effect<SessionCloseReport>;
    /** A process shutdown's close: drain what the plugins' pollers admitted,
     *  then close every held session at once, under one deadline. */
    readonly closeAll: Effect.Effect<readonly SessionCloseReport[]>;
  }
>()('@texra-ai/harness/SessionOwner') {}

/** A root launch as `session.start` hands it over: the configuration it
 *  resolved, the run id it minted, the start's options in its own words
 *  (`StartOptionsSchema`), and the run's own tools. */
type RootLaunch = typeof StartOptionsSchema.Type &
  Pick<ExecuteAgentOptions, 'tools'> & {
    readonly config: AgentConfig;
    readonly runId: RunId;
  };

/**
 * START HERE: a root launch, what `session.start` runs. The composition
 * root's `SessionOwner` must still hold the session. It answers the commit
 * of the run's opening once that commits, the run going on on the session's
 * fork; a launch that fails first fails this, and the caller's interruption
 * before then stops the run.
 *
 * A run with a parent, or one that is resumed rather than registered here
 * (a child's strategy, `resumeRun`), runs the lower-level `executeAgent`
 * through `RunRegistry.start` instead.
 */
export const rootRun = Effect.fn('rootRun')(function* (
  launch: RootLaunch,
): Effect.fn.Return<CommitOrdinal, Error, SessionOwner | SessionServices> {
  const runs = yield* Runs;
  const { storage } = yield* SessionRoots;
  if (!(yield* (yield* SessionOwner).holds(storage, runs)))
    return yield* Effect.fail(
      new Error('This session is closed; open it again to launch a run.'),
    );
  const opened = yield* Deferred.make<CommitOrdinal>();
  const onAdmitted = (_: RunId, commit: CommitOrdinal) =>
    Deferred.succeed(opened, commit);
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(
      registryOf(runs).start(
        launch.runId,
        admittedRun(launch, onAdmitted),
        (run) => run,
      ),
      (fiber) =>
        restore(
          Effect.raceFirst(
            Deferred.await(opened),
            Fiber.join(fiber).pipe(Effect.andThen(activationIfOpened(opened))),
          ),
        ).pipe(
          // A caller interrupted as the run opened never holds it.
          Effect.tap(() => restore(Effect.void)),
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        ),
    ),
  );
});

/**
 * The run a root launch admits, on the launched fiber, whose generation
 * holds the run's claim: it resolves the model and runs the run. The run is
 * born with its opening, so a launch that fails before it leaves no run:
 * its failure is the launch's.
 */
const admittedRun = Effect.fn('admittedRun')(function* (
  launch: RootLaunch,
  onAdmitted: NonNullable<ExecuteAgentOptions['onAdmitted']>,
) {
  const { runId, continues, approval } = launch;
  // Resolve the selected model before registering the run. The helper
  // model swap reads the enabled-model list and the routing switches, so it
  // takes this session's setting slots.
  const config = launch.helperModel
    ? yield* applyHelperModelPreference(launch.config, yield* SessionRoots)
    : launch.config;
  const definition = yield* prepareAgentDefinition({
    config,
    stopAfterCycle: launch.interactive !== true,
  });
  // A chat round takes the human grants of the round it continues, never
  // its launch limit: the round asks with the chat's policy now. A launch
  // whose delegated work starts approved grants every bypass over them.
  const inherited =
    continues !== undefined && continues !== runId
      ? inheritedGrants(
          SubscriptionRef.getUnsafe((yield* SessionViewAccess).ref),
          continues,
        )
      : NO_APPROVAL_GRANTS;
  const { limit: _previous, ...grants } = approval?.delegated
    ? humanGrant(APPROVAL_BYPASS_KINDS, true)(inherited)
    : inherited;
  // A policy the launch asked for, Auto-approve aside, is the run's
  // limit whatever the project's is now, so widening the project's
  // policy later never widens this run.
  const limit: ApprovalPolicyLimit | undefined =
    approval?.policy === 'yolo' ? undefined : approval?.policy;
  return yield* executeAgent(definition, runId, {
    tools: launch.tools,
    onAdmitted,
    registration: {
      identity: { kind: 'agent', agent: definition.config.agent },
      grants: limit === undefined ? grants : { ...grants, limit },
    },
  });
});
