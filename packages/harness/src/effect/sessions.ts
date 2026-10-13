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
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import type {
  AgentDirectoriesPort,
  ToolMissingHandler,
} from '@platform/interfaces';
import type { LanguageModelPort } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type {
  CommitOrdinal,
  FoldInput,
  InlinePersona,
  RequestDecision,
  RunId,
  TranscriptSubscription,
} from '@shared/schemas';
import type { ReadonlyDeep } from '@shared/session/readonlyDeep';
import type { RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type {
  SessionView as RuntimeSessionView,
  RunView as RuntimeRunView,
  TranscriptView as RuntimeTranscriptView,
} from '@shared/session/sessionView';
import type { Plugin } from '@tools/plugins';
import type { Effect, Stream, Scope } from 'effect';

import type {
  LaunchError,
  ResumeRefused,
  RunFailure,
  ToolsRefused,
  TraceUnavailable,
} from './errors.js';

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
  /** The MCP config file (`.mcp.json` shape) the process's tool registry
   *  reads; `nodePlatform()` names the one under its `storageDir`. */
  readonly mcpConfigPath: string;
}

/** What an embedder composes the process from: its platform and its
 *  plugins (the harness's built-ins among them). The setting rows its
 *  plugins read travel with the platform's config (`ConfigProvider.catalog`). */
export interface Composition {
  readonly platform: AgentPlatform;
  readonly plugins: readonly Plugin[];
}

/** One published level of the session's fold: an immutable value. */
export type SessionView = ReadonlyDeep<RuntimeSessionView>;
/** One stream of the {@link SessionView}. */
export type RunView = ReadonlyDeep<RuntimeRunView>;
/** A stream's transcript slice: what hosts paint. */
export type TranscriptView = ReadonlyDeep<RuntimeTranscriptView>;
/** A request a run waits on a person for, as {@link SessionView} lists it:
 *  which run asks, the request's id, and its payload (`payload.kind` is
 *  what is asked: a command, an edit, a plan, a retry, a question). */
export type PendingRequest = SessionView['requests'][number];

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
 *  differs fails with `SessionOptionsConflict`. */
export interface OpenOptions {
  /** Keep the session's history in the root's SQLite store (under
   *  `roots.storage`, the store every TeXRA host keeps), so a later process
   *  reopens it and resumes its runs. Absent, the store is in memory and
   *  ends with the session. */
  readonly persistent?: boolean;
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
  /** Run on the configured helper model (the "fix LaTeX" actions). */
  readonly helperModel?: boolean;
  /** A quota-exhausted retry offers the user's own API key. */
  readonly ownKeyFallback?: boolean;
  /** The policy the launch asked for (it only ever narrows the project's),
   *  and whether delegated work starts approved (Auto-approve). */
  readonly approval?: {
    readonly policy?: TexraApprovalPolicy;
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

/** One session of the process's owner: a root's runs, its view, and the
 *  hosts attached to it. */
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
