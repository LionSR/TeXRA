# `@texra-ai/harness`

<!-- Generated from `packages/harness/src/index.ts` by `npm run docgen`; do not edit. -->

`@texra-ai/harness`: run an agent from a Node program, stated in Effect.

> **Guide:** Read [Philosophy & Architecture](/api/) and
> [Durable Protocol & Recovery](/api/durable-protocol) for how the runtime
> works and how to embed it.

What an embedder needs to know, in order:

1. `Sessions.layer({ platform, plugins })` builds the process. `platform`
   comes from `nodePlatform()` in `./node`; `plugins` is `harnessBuiltins`
   from `./plugins`, plus any plugin of your own.
2. `sessions.open(roots)` gives the {@link Session} of one workspace.
3. `session.start({ agent, instruction })` gives a {@link Run}: read
   `run.events` for its progress and `run.result` for how it ended.
4. `session.resume(runId)` continues a run a persistent session stored.
5. `session.attach({ approve })` answers the approvals a run asks for.

The surface is Effect: nothing here calls `Effect.runPromise`; your
program runs it at its own entry point. Every failure is a tagged error
listed below.

### Companion subpaths

- [`@texra-ai/harness/schemas`](./schemas): browser-safe Effect Schemas, view
  types (`SessionView`, `RunView`, `TranscriptView`), and pure view queries.
- [`@texra-ai/harness/transcript`](./transcript): browser-safe transcript row
  projections and `RemoteSessionView` for UI renderers.
- [`@texra-ai/harness/plugins`](./plugins): built-in plugins (`harnessBuiltins`)
  and what a tool or plugin is written with (`definePlugin`, `ToolContext`).
- [`@texra-ai/harness/node`](./node): `nodePlatform(options)` and Node.js
  filesystem, SQLite, and process building blocks.
- [`@texra-ai/harness/host`](./host): what a full application host (TeXRA's
  editor, desktop and terminal apps) composes beyond this entry:
  `processLayer`, the agent catalog, settings, stores and secrets.

## AgentEvent

Discriminated union of every event the SDK surface emits.

```ts
type AgentEvent =
  | TraceArm<
      | 'log'
      | 'stage.start'
      | 'stage.end'
      | 'tool.start'
      | 'tool.end'
      | 'usage'
      | 'conversation.progress'
      | 'run.fact'
      | 'context.state'
      | 'stream.start'
      | 'stream.end'
    >
  | StreamChunkEvent;
```

## AgentNotFound

No agent of that name in the catalog, with what the last load said.

```ts
class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  'AgentNotFound',
  { agent: Schema.String, message: Schema.String },
)
```

## AgentPlatform

The process services the package composes, together with the workspace
roots the package's runs work in. `nodePlatform()` builds all of them; an
embedder supplying its own names its workspace roots beside them.

```ts
interface AgentPlatform {
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
```

## AgentRunListingEntry

A run a user started themselves, as a history list shows it: an agent run
with no parent. Background processes and scripts (`identity.kind`) and the
runs an agent spawned, which belong to their parent's transcript, are not
listed; a lookup by explicit id reads the run's records instead.

```ts
interface AgentRunListingEntry {
  id: RunId;
  timestamp: string;
  /** The run's folded status; a terminal outcome phase is its durable
   *  outcome. */
  status: RunLifecycleStatus;
  /** A stop rested the run (the fold's paused substate), a status of its own. */
  paused?: true;
  /** AI-generated summary of what the session aimed to accomplish. */
  description?: string;
  /** The model the run is on, as the view folds it: its newest
   *  `run.config`'s. */
  model?: string;
  /** `deriveResumability` finds a point to continue from. Ownership and
   *  loadability are settled when the run is opened. */
  resumable: boolean;
  /** Why the run cannot resume in this build although it may have rows to
   *  continue from: they could not be read, or an earlier build wrote them.
   *  Absent when it resumes or simply has nothing to continue from. */
  resumeBlocked?: string;
  /** What the run is — the durable authority, stamped at registration. */
  identity: Extract<RunIdentity, { kind: 'agent' }>;
  record: AgentConfig;
}
```

## ApprovalHandler

A host's answer to each request a run of the session waits on: an
approval, a denial with its reason, or for a retry, `retry` or `cancel`.
The session records it as the request's `request.decided`, through the
same `request.decide` a {@link Session.request} sends. A handler that
fails, throws, or has not answered within ten minutes is a denial, with
the cause logged.

```ts
type ApprovalHandler = (
  request: PendingRequest,
) => Effect.Effect<RequestDecision, Error>;
```

## Cancelled

The user cancelled the operation. No refusal notice is needed.

```ts
class Cancelled extends Schema.TaggedError<Cancelled>()(
  'Cancelled',
  {},
)
```

## Composition

What an embedder composes the process from: its platform and its
plugins (the harness's built-ins among them). The setting rows its
plugins read travel with the platform's config (`ConfigProvider.catalog`).

```ts
interface Composition {
  readonly platform: AgentPlatform;
  readonly plugins: readonly Plugin[];
}
```

## DatabaseOpenFailed

The database could not be opened, or its schema could not be applied.

```ts
class DatabaseOpenFailed extends Schema.TaggedError<DatabaseOpenFailed>()(
  'DatabaseOpenFailed',
  storeFailure,
)
```

## DatabaseReadFailed

A query failed or encountered an invalid persisted row.

```ts
class DatabaseReadFailed extends Schema.TaggedError<DatabaseReadFailed>()(
  'DatabaseReadFailed',
  storeFailure,
)
```

## DefinedTool

A defined tool: plain data plus a `call` that validates and normalizes
failures. An anonymous object type so the SDK's `.d.ts` inlines it.

```ts
type DefinedTool<T, R = never> = Omit<
  ITool<Error, R>,
  'call' | 'guard'
> & {
  call(
    rawInput: unknown,
  ): Effect.Effect<ToolResult, Error, Exclude<R, Scope.Scope>>;
  readonly guard?: ToolGuard<T, R>;
};
```

## defineTool

Define a tool: validate the model's input against `schema`, run `execute`,
and turn ordinary failures into `{ status: 'error' }` feedback.
Interruption, run history refusals and database write failures propagate.

```ts
function defineTool<T, R = never>(
  def: DefineToolOptions<T, R>,
): DefinedTool<T, R>
```

## HeldRun

What this process holds of one run ({@link LocalSession.held}).

```ts
interface HeldRun {
  readonly runId: RunId;
  /** A generation of it is live here: its fiber, a hold, or a launch. */
  readonly live: boolean;
  /** Resolves once every owner of it here has left. */
  readonly drained: Effect.Effect<void>;
  /** Why its running loop would refuse to switch to `model`; undefined
   *  when it would not, or when no loop of it runs here. */
  readonly modelSwitchDisabledReason: (
    model: string,
  ) => Effect.Effect<string | undefined, Error>;
}
```

## HostRequestFailure

How a host's request handler fails: with a tagged error, always. Three tags are the refusals the bridge folds
onto the wire ({@link RequestRefusal}); every other tag is a defect it
logs and answers `Internal` — but it is a *named* defect, so the log says
which capability produced it. The bound is structural because the tags a
host raises are its own (its lifted capabilities, its preview host, its
housekeeping); what every host owes this channel is that each of them is
a tag, so a bare `new Error(...)` can no longer reach the fold.

```ts
interface HostRequestFailure extends Error {
  readonly _tag: string;
}
```

## Internal

A handler died. The cause is in the host log under `ref` (the request
id); the surface hears that the request failed, never the text.

```ts
class Internal extends Schema.TaggedError<Internal>()('Internal', {
  ref: Schema.String,
})
```

## isRequestRefusal

Whether a failure is one of the three the bridge answers on the wire.

```ts
function isRequestRefusal(error: unknown): error is RequestRefusal
```

## ITool

Contract for tool implementations.
`defineTool` provides the canonical implementation with schema validation. Expected
tool failures are returned as literal `{ status: 'error', error: ... }`
ToolResult values; unexpected/programmer failures should throw and let
`defineTool` convert them at the boundary.

```ts
interface ITool<E = Error, R = never> {
  readonly definition: ToolDefinition;
  /** Hosts this tool is statically excluded from; an omitted host supports it. */
  readonly unavailableHosts?: readonly SettingHost[];
  /** The host capability (named by the plugin that serves it,
   *  `HostCapabilities`) the session's host must serve for this tool to be
   *  offered, read live each step: a window that attaches mid-run brings it. */
  readonly hostCapability?: string;
  /** Launches agents' tasks (a plugin's block): its step lists the agents
   *  with one. */
  readonly launchesTasks?: true;
  /**
   * Where its calls run beside their siblings (omitted: `'barrier'`).
   * Declared on the tool, not the YAML-overridable definition, so an agent
   * config cannot move an arbitrary tool out of order.
   *
   * - `'parallel'`: side-effect-free AND approval-free, so calls of one
   *   response (or one script) run concurrently within the parallel window,
   *   and identical ones collapse onto one (`partitionDuplicateCalls`). A
   *   read-only tool that prompts for approval is not parallel: it needs an
   *   approval round-trip first, so it stays a barrier.
   * - `'barrier'`: waits for every call issued before it and holds back
   *   every call after it until it settles.
   * - `'own'`: in a script, its calls neither wait for the calls issued
   *   before them nor block the ones after, and take no place in the
   *   parallel window: the tool bounds how many of its own calls run at
   *   once (a call that waits on a child run). A later barrier still waits
   *   for it; a response's call of it is a barrier.
   */
  readonly lane?: DispatchFacts['lane'];
  /**
   * The tool is also a global function of a script, taking its `positional`
   * field as the first argument and the rest as the second:
   * `agent(prompt, opts)` for `tools.agent({ prompt, ...opts })`.
   * `withScript`: a function of scripts alone (`self()`), offered whenever
   * the script tool is.
   */
  readonly scriptGlobal?: {
    readonly positional: string;
    readonly withScript?: true;
  };
  /**
   * Whether a call recorded as started, with no result, may run again on
   * resume without asking: `'safe'` only for a read-only or idempotent tool,
   * whose second run changes nothing the first did not. Omitted is
   * `'unsafe'`. Independent of `lane`, which is about concurrency.
   * The response row saves the declaration with each call, and a resume
   * re-runs a call only when that saved word and the current one both say
   * `'safe'` (`toolUseDispatch.ts`).
   */
  readonly replay?: 'safe' | 'unsafe';
  /**
   * Whether a call needs a person's approval, and who asks for it. `true`:
   * the run loop asks before the body runs, spelling the call as `guard.bash`
   * does when the guard names one and as the tool's name and arguments
   * otherwise, so a tool cannot declare approval and run unasked.
   * `'inBody'`: the body opens its own request (a file-edit review, a plan, a
   * question, a delegation proposal, an external inquiry) and the loop does
   * not ask again. Either
   * way, a run that cannot present a prompt is not offered the tool.
   */
  readonly requiresApproval?: boolean | 'inBody';
  /** Its card opens before the call runs; a fast tool's opens and closes
   *  with its settlement. */
  readonly slow?: boolean;
  /** The loop-side guard this tool declares; see {@link ToolGuard}. */
  readonly guard?: ToolGuard<never, R>;
  /**
   * A description rendered from the other tools the run declares, in place
   * of `definition.description`: rendered at the step that freezes the
   * run's system text and kept as that step recorded it until a compaction
   * opens the freeze again (`step.ts`), so a catalog change mid-run leaves
   * its text, and the cached prefix through it, as it was. The tool that has
   * one is the script tool, which reaches nothing but the run's other tools
   * and its own agent: a child is offered it, and its script-only functions,
   * whatever its parent was.
   */
  readonly describe?: (
    declared: readonly Pick<ITool, 'definition' | 'scriptGlobal'>[],
  ) => string;
  call(rawInput: unknown): Effect.Effect<ToolResult, E, R>;
}
```

## LaunchError

What a launch refuses before any model work: the two an embedder
branches on. A run that fails after admission fails with
{@link RunFailure} instead.

```ts
type LaunchError = AgentNotFound | ToolsRefused;
```

## LocalSession

A session this process holds (`Sessions.open`): every {@link Session}'s
members, and the reads of its store, the runs it holds here and the
notices it presents.

```ts
interface LocalSession extends Session {
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
```

## NotOwner

Another live owner holds the run this request would act on.

```ts
class NotOwner extends Schema.TaggedError<NotOwner>()('NotOwner', {
  runId: RunIdSchema,
})
```

## OpenOptions

How a root's session is opened. A later open of the same root gets the
session already there, and must ask for the same store: one that
differs fails with `SessionOptionsConflict`. What `host` says is read
only by the open that builds the session.

```ts
interface OpenOptions {
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
```

## Outcome

What the runtime answers a request with.

```ts
type Outcome = typeof OutcomeSchema.Type;
```

## Plugin

One plugin: what it contributes to a run. How an app shows it (a
dashboard card's copy, its setup guide, its settings rows) is the app's
own record, keyed by `id`.

```ts
interface Plugin {
  /** Stable, persisted identifier (the switch key, the plugin a run's
   *  offered tool records, and the name of its `resources/plugins/<id>/`
   *  directory): lowercase letters, digits and dashes, starting with a
   *  letter or digit. A list with any other id is refused. */
  readonly id: string;
  /** Its tools, by registered name. */
  readonly tools?: Readonly<Record<string, ITool<Error, PluginToolServices>>>;
  /**
   * Present when the plugin has an external dependency: it is probed, and
   * its tools are withheld while the dependency is missing. Without it the
   * plugin is built in and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  /** The plugin has a user switch, which a fresh install sets to this
   *  position; while off, its tools are withheld from every agent. It must
   *  be probed (`availability`, `ALWAYS_AVAILABLE` when it needs nothing
   *  installed). Without one the plugin is always on. */
  readonly toggle?: 'on' | 'off';
  /** Tools of this plugin offered to every agent with tools, declared or not,
   *  while the plugin is on and a boolean catalog setting is on: tool name to
   *  setting key, or `true` for no setting but the plugin's own switch. An
   *  injected tool still passes the host and approval gates; a script's
   *  run (a task's recipe) and a text-only persona get none. */
  readonly injectedWhen?: Readonly<Record<string, string | true>>;
  /** Its section of each request's system text, pinned while it is on. */
  readonly prompt?: PromptSection;
  /** Process-lifetime services, up while the plugin is switched on or a step
   *  pins it. A host-supplied one (VS Code's Lean services) is passed with
   *  the host's plugin value. */
  readonly processLayer?: ProcessPluginLayer;
  /** Session-lifetime services, one per open session, up while the plugin
   *  is switched on or a step of that session pins it. */
  readonly sessionLayer?: SessionPluginLayer;
  /** Its side of a decision on a pending request of its kind, on or off. */
  readonly decision?: RequestDecisionHook;
  /** The row kinds it owns (`plugin.fact`), on or off: rows outlive it. */
  readonly arms?: readonly PluginArm[];
  /** The agent-file block it owns (`AgentBlock`), on or off. */
  readonly agentBlock?: AgentBlock;
  /** Script module sources by name, imported as `builtIn:<name>`. */
  readonly scriptModules?: Readonly<Record<string, string>>;
  /** The plugins it runs on, by id; a list lacking one is rejected. */
  readonly requires?: readonly string[];
}
```

## PluginsRefused

The plugin list cannot be composed, for a defect `toolTable` refuses: an
id that is not lowercase letters, digits and dashes, an id or tool name
listed twice, a second plugin continuing parked runs or recording one
request kind's decisions, or a switch on a plugin with no availability
probe.

```ts
class PluginsRefused extends Schema.TaggedError<PluginsRefused>()(
  'PluginsRefused',
  {
    message: Schema.String,
  },
)
```

## Rejected

The runtime refused the request for a worded reason.

```ts
class Rejected extends Schema.TaggedError<Rejected>()('Rejected', {
  reason: Schema.String,
  docsPage: Schema.optional(Schema.String),
})
```

## RequestError

How a runtime request fails: one of the tagged errors above.

```ts
type RequestError = typeof RequestErrorSchema.Type;
```

## RequestRefusal

A request's refusal, as opposed to its defect: the three a handler may
answer the surface with. The bridge folds these onto the wire; every other
tag is `Internal`.

```ts
type RequestRefusal = Cancelled | Unavailable | Rejected;
```

## ResumeInput

What a resume takes beside its run: the custom tools the run needs
again, and whether it is a window's.

```ts
type ResumeInput = Pick<StartInput, 'tools' | 'interactive'>;
```

## ResumeRefused

A run `session.resume` will not continue, for the runtime's reason
(`ResumeRefusal`).

```ts
class ResumeRefused extends Schema.TaggedError<ResumeRefused>()(
  'ResumeRefused',
  {
    runId: Schema.String,
    reason: ResumeRefusalSchema,
    message: Schema.String,
  },
)
```

## Run

One run of an agent, from the moment it exists in its session.

```ts
interface Run {
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
```

## RunDeletion

What {@link LocalSession.deleteRuns} did with the runs it was asked for.

```ts
interface RunDeletion {
  /** How many listed runs the target named. */
  readonly listed: number;
  readonly deleted: readonly RunId[];
  /** Held by a live owner: left as is. */
  readonly active: readonly RunId[];
  readonly failed: readonly {
    readonly runId: RunId;
    readonly error: RequestError;
  }[];
}
```

## RunEnd

```ts
type RunEnd = typeof RunEndSchema.Type;
```

## RunFailure

A run that failed on its own. `cause` is exactly what the launch path
threw.

```ts
class RunFailure extends Schema.TaggedError<RunFailure>()('RunFailure', {
  cause: Schema.Defect(),
  message: Schema.String,
})
```

## RunRecords

One run's committed records ({@link LocalSession.records}), read from the
session's store as of each call. A run that never existed or was removed
reads as absent: no config, no end, nothing to resume.

```ts
interface RunRecords {
  /** Its `run.start` is still listed. */
  readonly exists: () => Effect.Effect<boolean, DatabaseReadFailed>;
  /** Its saved setup; null for a run that saved none (not an agent's). */
  readonly readConfig: () => Effect.Effect<
    AgentConfig | null,
    DatabaseReadFailed
  >;
  /** The report its agent wrote, or null. */
  readonly readReport: () => Effect.Effect<string | null, DatabaseReadFailed>;
  /** Its terminal fact (outcome, error, output, usage), or null while it
   *  has not ended. */
  readonly readRunEnd: () => Effect.Effect<RunEnd | null, DatabaseReadFailed>;
  /** Its result as delivered: the terminal fact with the output its
   *  delivery reported, or a background command's own record. */
  readonly readResult: () => Effect.Effect<
    RunResult | null,
    DatabaseReadFailed
  >;
  /** The workspace files its settled calls edited that are still there,
   *  under its working directory, by path. */
  readonly readWorkspaceFiles: () => Effect.Effect<
    RunWorkspaceFile[],
    DatabaseReadFailed | PlatformError.PlatformError
  >;
  /** The skills its latest step listed. */
  readonly readSkills: () => Effect.Effect<
    readonly string[],
    DatabaseReadFailed
  >;
  /** A model call's failure stopped its turn, and nothing retired it. */
  readonly readModelFailed: () => Effect.Effect<boolean, DatabaseReadFailed>;
  /** Its rows hold a point it continues from, ownership aside; rows that
   *  cannot be read (logged) hold none. */
  readonly readResumable: () => Effect.Effect<boolean>;
  /** Why a resume of it here is rejected, or null when it may go ahead. */
  readonly readRejection: () => Effect.Effect<RunRejection | null, Error>;
  /** Its conversation as every conversation view renders it. */
  readonly readConversation: () => Effect.Effect<ExportNode[], Error>;
  /** Its exported trace: its display rows and its record. */
  readonly readTrace: () => Effect.Effect<AssembleTraceResult, Error>;
}
```

## RunResult

The public value of one run's result endpoint (`readResult`): the run's
terminal result with the output as its delivery reported it, or a
background command's own record. The terminal fields are absent while the
run has not ended.

```ts
type RunResult =
  | Extract<ResultMeta, { producer: 'backgroundBash' }>
  | (Omit<RunEnd, 'outcome'> & { readonly outcome?: RunOutcome });
```

## RunStopReason

Why a run stops: a `user` stop or this process's `shutdown`.

```ts
type RunStopReason = typeof RunStopReasonSchema.Type;
```

## Session

One session: a root's runs, its view, and the hosts attached to it,
whether this process holds it ({@link LocalSession}) or a window drives
the background service's.

```ts
interface Session {
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
    ) => Stream.Stream<readonly SessionViewInput[]>;
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
```

## SessionHost

A host attached to a session ({@link Session.attach}): the presentation
surface it serves, and the answer it gives the runs' requests. With no
host attached that answers (`approve`, or a surface that can prompt), the
session cannot ask: its policy denies every request and offers no
approval-gated tool.

```ts
interface SessionHost extends Omit<HostInteractions, 'dispose'> {
  /** Answers each request a run of the session waits on. */
  readonly approve?: ApprovalHandler;
}
```

## SessionOpenError

Why a session's root could not be opened: its database or its reads
failed, or it is open over the other store.

```ts
type SessionOpenError =
  DatabaseOpenFailed | DatabaseReadFailed | SessionOptionsConflict;
```

## SessionOptionsConflict

A root's session is already open over the other store (persistent or
in memory), which it keeps: an open asking for the other is refused.

```ts
class SessionOptionsConflict extends Schema.TaggedError<SessionOptionsConflict>()(
  'SessionOptionsConflict',
  { storage: Schema.String, message: Schema.String },
)
```

## Sessions

The process's sessions: one per workspace storage root, through its one
`SessionOwner`.

```ts
class Sessions extends Context.Service<
  Sessions,
  {
    /** The session of `roots`, built now or the one already open; `options`
     *  decide its store. */
    readonly open: (
      roots: WorkspaceRoots,
      options?: OpenOptions,
    ) => Effect.Effect<LocalSession, SessionOpenError>;
    /**
     * Refuse new runs, settle the ones it owns inside the runtime's
     * shutdown-phase budget, flush, release.
     */
    readonly close: (
      roots: WorkspaceRoots,
    ) => Effect.Effect<SessionCloseReport>;
    /** A process shutdown's close: drain what the plugins' pollers
     *  admitted, then close every open session at once, under one
     *  deadline. */
    readonly closeAll: Effect.Effect<readonly SessionCloseReport[]>;
    readonly list: Effect.Effect<readonly LocalSession[]>;
  }
>()('@texra-ai/harness/Sessions')
```

## StartInput

What starting a run on a session takes: the agent, by name or written
inline (`InlinePersonaSchema`, recorded so a resume needs no file), or
a host's whole configuration; then the launch's facts.

```ts
type StartInput = (
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
```

## StreamChunkEvent

Chunk appended to an open stream. Transient: `runEventDraft` returns null
for it and the session graph carries the text instead, so it has no
session arm to derive from.

```ts
interface StreamChunkEvent {
  readonly type: 'stream.chunk';
  readonly id: string;
  readonly text: string;
}
```

## ToolResult

```ts
type ToolResult = typeof ToolResultSchema.Type;
```

## ToolsRefused

The tools the caller passed cannot run here: a tool that requires
approval, on a session opened without an approval handler.

```ts
class ToolsRefused extends Schema.TaggedError<ToolsRefused>()(
  'ToolsRefused',
  {
    tools: Schema.Array(Schema.String),
    message: Schema.String,
  },
)
```

## TraceUnavailable

A run's trace that no reader can take any more: `ended` (the run settled
with nobody reading, so its buffered trace went with it), `truncated`
(it passed the handover buffer before a reader attached, so the trace
was detached) or `remote` (the run runs in another process, which keeps
its trace). The run itself is unaffected: its `result` still answers.

```ts
class TraceUnavailable extends Schema.TaggedError<TraceUnavailable>()(
  'TraceUnavailable',
  {
    runId: Schema.String,
    reason: Schema.Literals(['ended', 'truncated', 'remote']),
    message: Schema.String,
  },
)
```

## Unavailable

The stream, request, or run the request names is gone or not in a state
that can take it.

```ts
class Unavailable extends Schema.TaggedError<Unavailable>()(
  'Unavailable',
  { runId: RunIdSchema, reason: Schema.String },
)
```

## WorkspaceRoots

One workspace's host services: its folder, storage, configuration and
state stores, as the session opened over it holds them.

```ts
interface WorkspaceRoots {
  /**
   * The product host this process is, named by its composition root. The
   * catalog rows whose slot differs by host and the tool gate's
   * `unavailableHosts` read it from here, so a read answers for the host that
   * opened these roots rather than for a default.
   */
  readonly host: SettingHost;
  /** Canonical physical workspace root, or undefined when no folder is open. */
  readonly workspace: string | undefined;
  /**
   * The storage root this process opened (a host's per-user directory, an
   * SDK embedder's `storageDir`): every storage path below derives from it, and
   * the files a person keeps there (the MCP config) are found beside it.
   */
  readonly storageRoot: string;
  /** Application-owned storage for this project's state. Custom hosts must
   * keep this separate from storage directories of earlier releases;
   * session services use this exact root without importing previous state. */
  readonly storage: string;
  /**
   * Cross-workspace global storage root. Process-wide by construction — every
   * host derives it from the one storage root it opened — and carried here
   * rather than as a process-wide value so the storage paths have a single
   * carrier.
   */
  readonly globalStorage: string;
  /** Workspace-scoped configuration (project `.texra/config.json` plus global). */
  readonly config: ConfigProvider;
  /** Workspace-scoped key-value state. */
  readonly workspaceState: StateStore;
  /**
   * Settings shared by every checkout of this workspace's git repository
   * (the catalog's `repoState` slot), in the global database.
   */
  readonly repoState: StateStore;
  /**
   * Process-wide application state: one of the slots the settings catalog
   * resolves a row against (`config`, `workspaceState`, `repoState`,
   * `globalState`).
   * Process-wide by construction like {@link globalStorage}, and carried here
   * rather than as a process-wide value so a caller that has resolved its roots holds
   * every slot. Inside Effect the owner is the `AppState` service.
   */
  readonly globalState: StateStore;
}
```
