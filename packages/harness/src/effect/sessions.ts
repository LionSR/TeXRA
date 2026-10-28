/**
 * The public shapes of `@texra-ai/harness`'s sessions and runs: what an
 * embedder or a host composes the process from, the {@link Session} it
 * holds for one root, and the {@link Run} it holds for one run. The
 * `Sessions` service that opens them is `processLayer.ts`'s; the programs
 * behind them are `sessionPrograms.ts`'s.
 */

import type { AgentEvent } from '@agent/trace';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  HostInteractions,
  SessionHostInteractions,
} from '@agent/runtime/HostInteractions';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import type { AgentRunListingEntry } from '@agent/storage/runListing';
import type {
  AgentDirectoriesPort,
  ToolMissingHandler,
} from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { HostSkillOptions } from '@platform/processRuntime';
import type { ApprovalPolicy } from '@shared/approvalPolicy';
import type {
  CommitOrdinal,
  DisplaySessionEvent,
  SessionViewInput,
  InlinePersona,
  RequestDecision,
  RunId,
  TranscriptSubscription,
} from '@shared/schemas';
import type {
  DatabaseReadFailed,
  SessionStoreMovedAside,
} from '@shared/session/database';
import type { RequestError } from '@shared/session/runtimeRequest';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type {
  PendingRequest,
  SessionView,
} from '@shared/session/readonlyViews';
import type { Plugin } from '@tools/plugins';
import type { Effect, Stream, Scope, SubscriptionRef } from 'effect';

import type {
  LaunchError,
  ResumeRefused,
  RunFailure,
  ToolsRefused,
  TraceUnavailable,
} from './errors.js';
import type { HeldRun, RunDeletion, RunRecords } from './sessionReads.js';

/**
 * The process services the package composes, together with the workspace
 * roots the package's runs work in. `nodePlatform()` builds all of them; an
 * embedder supplying its own names its workspace roots beside them.
 */
export interface AgentPlatform {
  /** The agent directories this process's `AgentDirectories` service serves. */
  readonly agentDirectories: AgentDirectoriesPort;
  /** Surfaces a tool-missing error to the embedder, served as
   *  `ToolMissingReporter`; absent, a missing-tool probe answers without
   *  surfacing. */
  readonly toolMissingHandler?: ToolMissingHandler;
  readonly roots: WorkspaceRoots;
  /** The secret store this process's `Secrets` service reads from. */
  readonly secrets: PlatformSecrets;
}

/** What an embedder composes the process from: its platform, its plugins
 *  (the harness's built-ins among them) and its skill sources, without
 *  which it discovers no skills. The setting rows its plugins read travel
 *  with the platform's config (`ConfigProvider.catalog`). */
export interface Composition {
  readonly platform: AgentPlatform;
  readonly plugins: readonly Plugin[];
  readonly skills?: HostSkillOptions;
}

/**
 * A host's answer to each request a run of the session waits on: an
 * approval, a denial with its reason, or for a retry, `retry` or `cancel`.
 * The session records it as the request's `request.decided`, through the
 * same `request.decide` a {@link Session.request} sends. A handler that
 * fails, throws, or has not answered within ten minutes is a denial, with
 * the cause logged.
 */
export type ApprovalHandler = (
  request: PendingRequest,
) => Effect.Effect<RequestDecision, Error>;

/** How a root's session is opened. A later open of the same root gets the
 *  session already there, and must ask for the same store: one that
 *  differs fails with `SessionOptionsConflict`. What `host` says is read
 *  only by the open that builds the session. */
export interface OpenOptions {
  /** Keep the session's history in the root's SQLite store (under
   *  `roots.storage`, the store every host keeps), so a later process
   *  reopens it and resumes its runs. Absent, the store is in memory and
   *  ends with the session. */
  readonly persistent?: boolean;
  /**
   * Set when a person is present to answer the runs' requests from the
   * view (`request.decide`), as in an editor window. Absent, nobody can
   * answer until a host with an `approve` handler attaches
   * ({@link Session.attach}), so every request is denied.
   *
   * `interruptedTasks` handles runs that a closed or crashed process left
   * unfinished. Both values resume such a run once what it was missing (an
   * agent, a plugin) is back. `offer` also lists them when the session
   * opens, and continues them when the `texra.resumeOnOpen` setting is
   * `auto`.
   */
  readonly host?: { readonly interruptedTasks?: 'offer' | 'retry' };
}

/**
 * A host attached to a session ({@link Session.attach}): the presentation
 * surface it serves, and the answer it gives the runs' requests. With no
 * host attached that answers (`approve`, or a surface that can prompt), the
 * session cannot ask: its policy denies every request and offers no
 * approval-gated tool.
 */
export interface SessionHost extends Omit<HostInteractions, 'dispose'> {
  /** Answers each request a run of the session waits on. */
  readonly approve?: ApprovalHandler;
}

/** What starting a run takes: an agent (a name from the agent
 *  directories, or a persona written inline, which the run stores so a
 *  resume needs no file) and the instruction to give it. Everything else
 *  is optional. `config` replaces both with a complete configuration an
 *  application host has already resolved. */
export type StartInput = (
  | {
      readonly agent: string | InlinePersona;
      readonly instruction: string;
      readonly model?: string;
    }
  | { readonly config: AgentConfig }
) & {
  /** The run's id. Absent, one is generated. */
  readonly runId?: RunId;
  /** The earlier run this one continues in a chat: the new run starts with
   *  the approvals the person granted there. */
  readonly continues?: RunId;
  /** Run on the configured helper model instead of the selected one. */
  readonly helperModel?: boolean;
  /** A stricter approval policy for this run (it can only narrow the
   *  project's), and whether work it delegates to other agents starts
   *  approved. */
  readonly approval?: {
    readonly policy?: ApprovalPolicy;
    readonly delegated?: boolean;
  };
  /** Keep the run open for follow-up messages after each answer, as a chat
   *  window does. Absent, the run ends after its first answer. */
  readonly interactive?: boolean;
  /** Tools for this run only, made with `defineTool`. A resume needs the
   *  same tools passed again. */
  readonly tools?: readonly ITool[];
};

/** What a resume takes besides the run's id: the same custom tools the
 *  run was started with, and whether it stays open for follow-ups. */
export type ResumeInput = Pick<StartInput, 'tools' | 'interactive'>;

/** One run of an agent, from the moment it exists in its session. */
export interface Run {
  /** The run's id, known before its first model call. */
  readonly runId: RunId;
  /** Set when you resumed a child run that its parent was still waiting
   *  on: the parent resumes instead (this handle is the parent's), and
   *  this names the child you asked for. */
  readonly redirectedFrom?: RunId;
  /**
   * How the run ended. A failed run fails this with its own
   * {@link RunFailure}. A finished run's result arrives once the session
   * view shows its stored outcome, so a view read afterwards includes it.
   */
  readonly result: Effect.Effect<RunEndResult, RunFailure>;
  /**
   * The session view while this run lasts: from the first snapshot that
   * shows the run to the first that shows its stored outcome. It cannot
   * fail; if the code that maintains the view crashes, that is a defect.
   */
  readonly view: Stream.Stream<SessionView>;
  /**
   * What the run does as it does it: streamed text, tool calls, stages,
   * usage. Pipe it through `responseText` for just the answer's text.
   * Ends when the run ends, and fails with {@link RunFailure} if the run
   * failed. Read it once, from the moment `start` returns: events wait
   * for you only briefly, and stopping early stops your reading, not the
   * run. A reader that comes too late fails with {@link TraceUnavailable}
   * instead of seeing nothing.
   */
  readonly events: Stream.Stream<AgentEvent, RunFailure | TraceUnavailable>;
  /** Stop the run. */
  readonly interrupt: Effect.Effect<void>;
}

/** One workspace's runs, the view of them, and the hosts attached to it.
 *  `Sessions.open` gives the {@link LocalSession} this process holds; a
 *  window connected to a background process holds a plain `Session`. */
export interface Session {
  readonly roots: WorkspaceRoots;
  /** The session's state as immutable snapshots: its runs, their status,
   *  and the requests waiting on a person. */
  readonly view: {
    /** The latest snapshot. */
    readonly current: () => SessionView;
    /** Every new snapshot, as the session changes. */
    readonly changes: Stream.Stream<SessionView>;
    /**
     * What a remote reader needs to build the view itself: a full replay of
     * the runs `set` names, then every change after `from.cursor`. Those
     * runs' transcripts stay up to date while the stream is read.
     */
    readonly watch: (
      set: readonly TranscriptSubscription[],
      from: { readonly cursor: CommitOrdinal; readonly debug: boolean },
    ) => Stream.Stream<readonly SessionViewInput[]>;
  };
  /**
   * Start a run. Succeeds once the run exists: it is in the view and its
   * events are flowing. A caller that does not get a {@link Run} back has
   * none running, even if interrupted halfway. A failure before then is
   * returned to you and shown to no host.
   */
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<Run, LaunchError | RunFailure>;
  /**
   * Continue a stored run from where its history stops, with the same kind
   * of handle {@link start} gives. Pass the custom `tools` it was started
   * with. Resuming a run already resuming here returns the same handle; a
   * run that cannot continue fails with {@link ResumeRefused}, whose
   * `reason` says why.
   */
  readonly resume: (
    runId: RunId,
    input?: ResumeInput,
  ) => Effect.Effect<Run, ResumeRefused | ToolsRefused | RunFailure>;
  /** Everything else you ask of the session, as one typed request
   *  (`RuntimeRequest` in `./schemas`: send a follow-up, answer an
   *  approval, stop, fork or delete a run, switch its model, and so on).
   *  Answered exactly once, with an outcome or a {@link RequestError}. */
  readonly request: (
    request: RuntimeRequest,
  ) => Effect.Effect<Outcome, RequestError>;
  /** Attach `host` until the caller's scope closes: it shows notices, and
   *  its `approve` answers the runs' approval requests. A session has one
   *  host at a time; attaching a second while one is attached is a defect. */
  readonly attach: (
    host: SessionHost,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * A session this process holds, as `Sessions.open` returns it: everything
 * a {@link Session} has, plus direct reads of its store (run listing,
 * records, deletion) and of the runs this process is running.
 */
export interface LocalSession extends Session {
  /** Set when opening found a store from an older build, or a damaged one,
   *  and moved it aside to start fresh; tell the person once. */
  readonly storeMovedAside: SessionStoreMovedAside | null;
  readonly view: Session['view'] & {
    /** Keep the transcripts of the runs `set` names in the view until the
     *  caller's scope closes. */
    readonly subscribe: (
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** A one-off snapshot built from the store: every run's summary, and
     *  the full transcript of the runs named. */
    readonly read: (runIds: readonly RunId[]) => Effect.Effect<SessionView>;
    /** The position of the store's latest write. Pass it to
     *  {@link events} to see only what is written from now on. */
    readonly head: () => CommitOrdinal;
    /**
     * Every displayable event of every run written after `from` (from
     * {@link head}, or a snapshot's `cursor`), in write order, then each
     * new one as it is written. `drained`, if given, is updated to the
     * position each read reached.
     */
    readonly events: (
      from: CommitOrdinal,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ) => Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
  };
  /** One run's stored records. */
  readonly records: (runId: RunId) => RunRecords;
  /** The runs a person started (not child runs), newest first, each with
   *  its saved setup. */
  readonly listRuns: () => Effect.Effect<AgentRunListingEntry[], Error>;
  /** The run `runId` if this process is running it, or every run it is
   *  running. */
  readonly held: {
    (runId: RunId): HeldRun | undefined;
    (): readonly HeldRun[];
  };
  /**
   * Delete one run, or every stored run (`'all'`). A run another live
   * process is running is skipped and reported as `active`. Deleting a
   * single run may take it from a process that cannot be proved alive or
   * dead; `'all'` never does.
   */
  readonly deleteRuns: (
    target: RunId | 'all',
  ) => Effect.Effect<RunDeletion, DatabaseReadFailed>;
  /** Show a notice through the attached host. With
   *  `replayWhenAttached`, a notice raised while no host is attached waits
   *  for the next one. */
  readonly emit: SessionHostInteractions['emit'];
  /** Wait until everything already sent to the session is written, shown
   *  in the view, and handled: for example, a failed run's end has been
   *  shown to the attached host (or queued for the next one). */
  readonly settled: Effect.Effect<void>;
}
