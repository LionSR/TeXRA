import { Context, Effect, SubscriptionRef } from 'effect';

import { Inbox } from '@agent/followUp/Inbox';
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
import type {
  AgentConfig,
  CommitOrdinal,
  RunId,
  SessionCloseReport,
} from '@shared/schemas';
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
import { prepareAgentDefinition } from './AgentLaunchContext';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { applyHelperModelPreference } from './helperModelName';
import { registryOf, Runs } from './runRegistry';
import type { SessionHandleInit } from './SessionHandle';
import type { Interactions } from './HostInteractions';
import type { ProjectTools } from './loop/step';
import type { SessionRequests } from './requests';

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
 * START HERE: a root launch, what `session.start` runs. It resolves the
 * model and the definition, commits the run's opening in this fiber
 * (`executeAgent`), and forks the run under its id on the session
 * (`RunRegistry.start`); it answers the commit of that opening. A launch
 * that fails before the run exists fails this with no run behind it; a
 * run that opened never fails this: its end, failed or not, is its
 * `run.end` row's.
 *
 * A run with a parent, or one that is resumed rather than registered here
 * (a child's strategy, `resumeRun`), runs the lower-level `executeAgent`
 * through `RunRegistry.start` instead.
 */
export const rootRun = Effect.fn('rootRun')(function* (
  launch: RootLaunch,
): Effect.fn.Return<CommitOrdinal, Error, SessionServices> {
  const runs = yield* Runs;
  const { runId, continues, approval } = launch;
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
  const autoApprove = approval === 'autoApprove';
  const { limit: _previous, ...grants } = autoApprove
    ? humanGrant(APPROVAL_BYPASS_KINDS, true)(inherited)
    : inherited;
  // A policy the launch narrows to is the run's limit whatever the
  // project's is now, so widening the project's policy later never widens
  // this run.
  const limit: ApprovalPolicyLimit | undefined = autoApprove
    ? undefined
    : approval;
  // The model (the helper model swap reads the enabled-model list and the
  // routing switches from this session's setting slots), the agent and its
  // tools resolve in the opening, each refused before any run is registered.
  const { opened } = yield* registryOf(runs).start(runId, {
    open: Effect.gen(function* () {
      const config = launch.helperModel
        ? yield* applyHelperModelPreference(launch.config, yield* SessionRoots)
        : launch.config;
      const definition = yield* prepareAgentDefinition({
        config,
        stopAfterCycle: launch.interactive !== true,
      });
      return yield* executeAgent(definition, runId, {
        tools: launch.tools,
        registration: {
          identity: { kind: 'agent', agent: definition.config.agent },
          grants: limit === undefined ? grants : { ...grants, limit },
        },
      });
    }),
    run: (prepared) => prepared.run,
  });
  return opened.activation;
});
