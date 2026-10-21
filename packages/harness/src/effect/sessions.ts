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
import type { LanguageModelPort } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { ApprovalPolicy } from '@shared/approvalPolicy';
import type {
  CommitOrdinal,
  DisplaySessionEvent,
  FoldInput,
  InlinePersona,
  RequestDecision,
  RunId,
  TranscriptSubscription,
} from '@shared/schemas';
import type {
  DatabaseReadFailed,
  SessionStoreMovedAside,
} from '@shared/session/database';
import type { RequestError } from '@shared/session/requestErrors';
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
  /** The bridge its `LanguageModel` service serves; an embedder with no
   *  editor passes `UNAVAILABLE_LANGUAGE_MODEL_PORT`, as `nodePlatform()`. */
  readonly languageModel: LanguageModelPort;
}

/** What an embedder composes the process from: its platform and its
 *  plugins (the harness's built-ins among them). The setting rows its
 *  plugins read travel with the platform's config (`ConfigProvider.catalog`). */
export interface Composition {
  readonly platform: AgentPlatform;
  readonly plugins: readonly Plugin[];
}

// The views a host reads, read-only all the way down.
export type {
  PendingRequest,
  RunView,
  SessionView,
  TranscriptView,
} from '@shared/session/readonlyViews';

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
   * The opener is an interactive host, whose surfaces answer the runs'
   * requests from the view (a `request.decide`), attached or not; absent,
   * nobody can answer until a host that does attaches
   * ({@link Session.attach}), so the session's policy denies every request.
   * A window sets `interruptedTasks`: it resumes a task whose resume was
   * blocked once what it needs is back, and with `offer` also lists at open,
   * or under `texra.resumeOnOpen: auto` continues, the tasks a closed or
   * crashed process left interrupted.
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

/** What starting a run on a session takes: the agent, by name or written
 *  inline (`InlinePersonaSchema`, recorded so a resume needs no file), or
 *  a host's whole configuration; then the launch's facts. */
export type StartInput = (
  | {
      readonly agent: string | InlinePersona;
      readonly instruction: string;
      readonly model?: string;
    }
  | { readonly config: AgentConfig }
) & {
  /** The id to admit the run under; one is minted when absent. */
  readonly runId?: RunId;
  /** The chat's previous root: the run starts with the grants it held. */
  readonly continues?: RunId;
  /** Run on the configured helper model instead of the selected one. */
  readonly helperModel?: boolean;
  /** A quota-exhausted retry offers the user's own API key. */
  readonly ownKeyFallback?: boolean;
  /** The policy the launch asked for (it only ever narrows the project's),
   *  and whether delegated work starts approved (Auto-approve). */
  readonly approval?: {
    readonly policy?: ApprovalPolicy;
    readonly delegated?: boolean;
  };
  /** A window's run, which parks for input after each cycle; absent, the
   *  run ends with its first cycle. */
  readonly interactive?: boolean;
  readonly tools?: readonly ITool[];
};

/** What a resume takes beside its run: the custom tools the run needs
 *  again, and whether it is a window's. */
export type ResumeInput = Pick<StartInput, 'tools' | 'interactive'>;

/** One run of an agent, from the moment it exists in its session. */
export interface Run {
  /** The run's id, minted here and handed to the launcher, so it
   *  identifies the run before its first model call. */
  readonly runId: RunId;
  /** Set when a resume asked for a child an open call of this run owns:
   *  the child resumes with this run, its parent, and this names it. */
  readonly redirectedFrom?: RunId;
  /**
   * The run's own outcome first: on failure the fold's fate never replaces
   * it; on success this waits for the level holding the durable outcome.
   */
  readonly result: Effect.Effect<RunEndResult, RunFailure>;
  /**
   * The session's levels sliced to this run: from the first level holding
   * its stream through the first holding its durable outcome. Typed error
   * `never`: a dead fold is a defect, as `SessionViewService.changes`
   * publishes it.
   */
  readonly view: Stream.Stream<SessionView>;
  /**
   * The run's trace, buffered from the moment the run enters the session so
   * that no launch event is lost to a reader that has yet to attach. Ends
   * when the run settles and fails with {@link RunFailure} when the run
   * failed. Running it once is the contract: ending the iteration detaches
   * the trace while the run continues. The pre-reader buffer is bounded: a
   * run that passes it with nobody reading detaches its trace, and a reader
   * that attaches after that, or after the run settled unread, fails with
   * {@link TraceUnavailable} rather than reading an empty trace.
   */
  readonly events: Stream.Stream<AgentEvent, RunFailure | TraceUnavailable>;
  /** Before the runtime hands over the live handle this aborts the launch;
   *  after, it interrupts the run. */
  readonly interrupt: Effect.Effect<void>;
}

/** One session: a root's runs, its view, and the hosts attached to it,
 *  whether this process holds it ({@link LocalSession}) or a window drives
 *  the background service's. */
export interface Session {
  readonly roots: WorkspaceRoots;
  /** The fold's levels, each an immutable value. */
  readonly view: {
    /** The current level. */
    readonly current: () => SessionView;
    readonly changes: Stream.Stream<SessionView>;
    /**
     * The ordered fold inputs for one reader: a complete replay of the
     * runs `set` names, then events from `from.cursor` before live text.
     * The reader's transcript interest lives as long as the stream.
     */
    readonly watch: (
      set: readonly TranscriptSubscription[],
      from: { readonly cursor: CommitOrdinal; readonly debug: boolean },
    ) => Stream.Stream<readonly FoldInput[]>;
  };
  /**
   * Admission: succeeds when the run exists in the session, with its stream
   * published and its trace live. Interrupting the caller before admission
   * aborts the launch; interrupting it during the handoff that follows ends
   * the run too, so a caller that does not receive a {@link Run} has none
   * running. A failure before admission is the caller's to present: `start`
   * presents nothing.
   */
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<Run, LaunchError | RunFailure>;
  /**
   * Continue a persisted run of this session through the one resume path
   * every host takes, from its committed history: the same handle and the
   * same admission as {@link start}, and the same custom `tools`, which a
   * persisted run needs again to continue a call to one. A child an open
   * call of its parent owns resumes with that parent
   * ({@link Run.redirectedFrom}). A resume of a run already resuming here
   * joins it, with the same handle. A run nothing can continue fails with
   * {@link ResumeRefused}.
   */
  readonly resume: (
    runId: RunId,
    input?: ResumeInput,
  ) => Effect.Effect<Run, ResumeRefused | ToolsRefused | RunFailure>;
  /** The one handler of every request a surface issues to this session:
   *  answered exactly once, an outcome or a request error. */
  readonly request: (
    request: RuntimeRequest,
  ) => Effect.Effect<Outcome, RequestError>;
  /** Attach `host` for the caller's scope: the newest attached host
   *  presents, and its `approve` answers the runs' requests. */
  readonly attach: (
    host: SessionHost,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * A session this process holds (`Sessions.open`): every {@link Session}'s
 * members, and the reads of its store, the runs it holds here and the
 * notices it presents.
 */
export interface LocalSession extends Session {
  /** Set when opening the store moved an older build's or a damaged store
   *  aside; the host that opened the session presents it once. */
  readonly storeMovedAside: SessionStoreMovedAside | null;
  readonly view: Session['view'] & {
    /** Fold the transcripts of the runs `set` names, beside every other
     *  reader's, for the caller's scope. */
    readonly subscribe: (
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** The view folded cold from the store as of this call: every run's
     *  listing, and the whole history of the runs named. */
    readonly read: (runIds: readonly RunId[]) => Effect.Effect<SessionView>;
    /** The store's head: the last commit, where a reader attaching now
     *  starts {@link events} to see only what commits from here on. A
     *  level's `cursor` can sit far behind it right after open. */
    readonly head: () => CommitOrdinal;
    /**
     * Every display row committed past `from` ({@link head}, or a level's
     * `cursor`), every run's, in commit order, then each as it commits. `drained` receives
     * the commit each forward read covered, a row the store no longer
     * holds included.
     */
    readonly events: (
      from: CommitOrdinal,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ) => Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
  };
  /** One run's committed records. */
  readonly records: (runId: RunId) => RunRecords;
  /** The runs a user started (agent runs with no parent), newest first,
   *  each with its saved setup. */
  readonly listRuns: () => Effect.Effect<AgentRunListingEntry[], Error>;
  /** What this process holds of `runId`, or of every run it holds. */
  readonly held: {
    (runId: RunId): HeldRun | undefined;
    (): readonly HeldRun[];
  };
  /**
   * Delete one run, or every run the store lists (`'all'`), through the
   * run's claim: a run a live owner holds is left (`active`). Only a
   * single run's deletion may take over an owner that cannot be proved
   * alive or dead.
   */
  readonly deleteRuns: (
    target: RunId | 'all',
  ) => Effect.Effect<RunDeletion, DatabaseReadFailed>;
  /** Present a notice through the newest attached host; with
   *  `replayWhenAttached`, a notice raised while none is attached waits
   *  for the next. */
  readonly emit: SessionHostInteractions['emit'];
  /** A barrier: every write enqueued before it has run, the view has
   *  folded what it committed, and the session's own consumers of those
   *  rows have run over them: a failed run's end has been presented to the
   *  attached host (or queued for the next one) by the time it returns. */
  readonly settled: Effect.Effect<void>;
}
