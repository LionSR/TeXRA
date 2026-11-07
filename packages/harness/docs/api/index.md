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
   `run.events` for its progress (`run.events.pipe(responseText)` for
   just the answer's text) and `run.result` for how it ended.
4. `session.resume(runId)` continues a run a persistent session stored.
5. `session.attach({ approve })` answers the approvals a run asks for.

Model requests go through the harness's own HTTP transport. To answer them
yourself (a scripted model in a test), merge {@link ModelFetch} beneath
`Sessions.layer` with `Layer.provideMerge`.

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
  | TraceRow<(typeof TRACE_ROW_TYPES)[number]>
  | StreamChunkEvent;
```

## AgentPlatform

The process services the package composes, together with the workspace
roots the package's runs work in. `nodePlatform()` builds all of them; an
embedder supplying its own names its workspace roots beside them.

```ts
interface AgentPlatform {
  /** The agent directories this process's `AgentDirectories` service serves. */
  readonly agentDirectories: AgentDirectoriesPort;
  readonly roots: WorkspaceRoots;
  /** The secret store this process's `Secrets` service reads from. */
  readonly secrets: PlatformSecrets;
}
```

## ApprovalHandler

A host's answer to each request a run of the session waits on: an
approval, a denial with its reason, or for a retry, `retry` or `cancel`.
The session records it as the request's `request.decided`, through the
same `request.decide` a {@link Session.request} sends. A handler that
fails, throws, or answers with a decision the request's kind does not
take is a denial, with the cause logged; it may take as long as it needs.

```ts
type ApprovalHandler = (
  request: PendingRequest,
) => Effect.Effect<RequestDecision, Error>;
```

## Composition

What an embedder composes the process from: its platform, its plugins
(the harness's built-ins among them) and its skill sources, without
which it discovers no skills. The setting rows its plugins read travel
with the platform's config (`ConfigProvider.catalog`).

```ts
interface Composition {
  readonly platform: AgentPlatform;
  readonly plugins: readonly Plugin[];
  readonly skills?: HostSkillOptions;
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
type DefinedTool<T, R = never, Name extends string = string> = Omit<
  ITool<Error, R>,
  'call' | 'guard' | 'definition'
> & {
  readonly definition: ToolDefinition & { readonly name: Name };
  call(
    rawInput: unknown,
  ): Effect.Effect<ToolResult, Error, Exclude<R, Scope.Scope>>;
  readonly guard?: ToolGuard<T>;
};
```

## defineTool

Define a tool: validate the model's input against `schema`, run `execute`,
and turn ordinary failures into `{ status: 'error' }` feedback.
Interruption, run history refusals and database write failures propagate.

A tool whose `execute` succeeds with a `ToolResult` carrying a `value`
hands a script that value in place of `{ output, summary }`. Declare its
TypeScript type in `scriptReturns`, which is what a script is told the
call resolves to. Nothing derives one from the other: a tool that returns
a `value` without `scriptReturns` is declared to scripts as resolving to
`ToolOutput`, so change the two together.

```ts
function defineTool<T, R = never, const Name extends string = string>(
  def: DefineToolOptions<T, R> & { readonly name: Name },
): DefinedTool<T, R, Name>
```

## HeldRun

What this process holds of one run ({@link LocalSession.held}): a launch
of it in flight here; a run with none has no record.

```ts
interface HeldRun {
  readonly runId: RunId;
  /** Resolves once every owner of it here has left. */
  readonly drained: Effect.Effect<void>;
  /** Why its running loop would refuse to switch to `model`; undefined
   *  when it would not, or when no loop of it runs here. */
  readonly modelSwitchDisabledReason: (
    model: string,
  ) => Effect.Effect<string | undefined, Error>;
}
```

## HISTORY_TABLES

The tables a history query reads and their columns, in order: the public
contract of `executions` `query`. A column changes meaning only with a
new name. `position` is load order, not the database's commit ordinal: a
rebuilt store renumbers it.

```ts
const HISTORY_TABLES: Readonly<{ runs: readonly ["id", "parent_id", "parent_call_position", "kind", "name", "model", "description", "started_at", "status", "outcome", "cost", "input_tokens", "output_tokens", "calls_unreadable"]; run_tree: readonly ["ancestor_id", "id", "depth"]; tool_calls: readonly ["position", "run_id", "call_id", "script_call_id", "tool", "input", "attempt", "status", "output", "value", "error", "issued_at", "started_at", "ended_at"]; model_calls: readonly ["position", "run_id", "invocation_id", "attempt", "model", "status", "output", "error", "input_tokens", "output_tokens", "cost", "started_at", "ended_at"]; }>
```

## isOutcomeOf

Whether `outcome` answers a request of `kind`: how a client reads an
answer that crossed a process boundary.

```ts
const isOutcomeOf: <K extends RuntimeCommand["kind"]>(kind: K, outcome: { readonly kind: "done"; } | { readonly kind: "followUp"; readonly id: string; readonly status: "sent" | "queued"; readonly receipt: { readonly state: "accepted"; } | { readonly state: "incorporated"; readonly turn: number; } | { readonly answer: number; readonly state: "answered"; readonly turn?: number | undefined; } | { readonly reason: "completed" | "failed" | "cancelled" | "noop" | "ended" | "closed"; readonly state: "unanswered"; readonly error?: string | undefined; readonly turn?: number | undefined; }; } | { readonly kind: "receipt"; readonly receipt: { readonly state: "accepted"; } | { readonly state: "incorporated"; readonly turn: number; } | { readonly answer: number; readonly state: "answered"; readonly turn?: number | undefined; } | { readonly reason: "completed" | "failed" | "cancelled" | "noop" | "ended" | "closed"; readonly state: "unanswered"; readonly error?: string | undefined; readonly turn?: number | undefined; }; } | { readonly kind: "forked"; readonly runId: string & Brand<"RunId">; } | { readonly kind: "preview"; readonly preview: { readonly originalContent: string; readonly proposedContent: string; readonly hunks: readonly { readonly oldStart: number; readonly oldLines: number; readonly newStart: number; readonly newLines: number; readonly lines: readonly string[]; }[]; readonly firstChangedLine: number | null; } | null; } | { readonly kind: "runFiles"; readonly result: { readonly status: "done"; readonly to?: string | undefined; } | { readonly status: "noFiles"; } | { readonly status: "error"; readonly error: string; }; }) => outcome is OutcomeOf<K>
```

## ITool

Contract for tool implementations.
`defineTool` provides the canonical implementation with schema validation.
A tool fails with an `Error` (usually a `ToolError`) and the model reads its
message as the call's error; a throw is a defect, which `defineTool` turns
into a failed call and logs as a crash unless it is a `ToolError`.

```ts
interface ITool<E = Error, R = never> {
  readonly definition: ToolDefinition;
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
   * the script tool is and never sent to the model as a tool of its own.
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
   * Whether a call needs a person's approval, and who asks. `true` (implied
   * by `guard.command`): the run loop, before the body runs. `'inBody'`: the
   * body's own request (an edit's review, a plan, a delegation proposal, a
   * question, a plugin's request), which answers what the call's hooks
   * said. A run that cannot present a prompt is not offered such a tool
   * (`asksApproval`).
   */
  readonly requiresApproval?: true | 'inBody';
  /** Its card opens before the call runs; a fast tool's opens and closes
   *  with its settlement. */
  readonly slow?: boolean;
  /** The loop-side guard this tool declares; see {@link ToolGuard}. */
  readonly guard?: ToolGuard<never>;
  /**
   * A description rendered from the other tools the run declares and the
   * modules its scripts may import, in place of `definition.description`:
   * rendered at the step that freezes the run's system text and kept as
   * that step recorded it until a compaction opens the freeze again
   * (`step.ts`), so a catalog change mid-run leaves its text, and the cached
   * prefix through it, as it was. The tool that has one is the script tool,
   * which reaches nothing but the run's other tools and its own agent: a
   * child is offered it, and its script-only functions, whatever its parent
   * was.
   */
  readonly describe?: (
    declared: readonly Pick<ITool, 'definition' | 'scriptGlobal'>[],
    /** The specifiers of the modules the step's scripts may import. */
    modules: readonly string[],
  ) => string;
  call(rawInput: unknown): Effect.Effect<ToolResult, E, R>;
}
```

## LaunchError

What a launch refuses before any model work: the two an embedder
branches on. A run that fails after admission fails with
{@link RunFailure} instead.

```ts
type LaunchError = LaunchRefused | ToolsRefused;
```

## LaunchRefused

A launch refused before its run exists, for an input its caller supplied:
an unknown agent or model (each with the `notice` a host shows in place of
the message), a persona or configuration its schema rejects, or a run id
already in use.

```ts
class LaunchRefused extends Schema.TaggedError<LaunchRefused>()(
  'LaunchRefused',
  {
    message: Schema.String,
    notice: Schema.optional(LaunchNoticeSchema),
  },
)
```

## LocalSession

A session this process holds, as `Sessions.open` returns it: everything
a {@link Session} has, plus the runs this process is running, its store's
positions and its notices.

```ts
interface LocalSession extends Session {
  /** Set when opening found a store from an older build, or a damaged one,
   *  and moved it aside to start fresh; tell the person once. */
  readonly storeMovedAside: SessionStoreMovedAside | null;
  readonly view: Session['view'] & {
    /** Keep the transcripts of the runs `set` names in the view until the
     *  caller's scope closes. */
    readonly subscribe: (
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** The position of the store's latest write. Pass it to
     *  {@link events} to see only what is written from now on. */
    readonly head: () => CommitOrdinal;
    /**
     * Every displayable event of every run written after `from` (from
     * {@link head}, or a snapshot's `cursor`), in write order, then each
     * new one as it is written. `drained`, if given, is updated to the
     * position each read reached.
     *
     * Another process's commit reaches this stream and the view on the same
     * poll of the store (about 250 ms), but the view applies it on its own
     * update fiber, so `current` read right after an event here can still
     * be the snapshot before it. A caller that acts on an event and then
     * needs the snapshot to show it waits on `changes` rather than reading
     * `current` once.
     */
    readonly events: (
      from: CommitOrdinal,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ) => Stream.Stream<DisplayRow, DatabaseReadFailed>;
  };
  /** The {@link Run} of `runId`'s activation at `activation`, as `start`
   *  or `resume` handed it out: a host that carries a handle across a
   *  process boundary answers its members from here. */
  readonly run: (runId: RunId, activation: CommitOrdinal) => Run;
  /** The run `runId` if this process is running it, or every run it is
   *  running. */
  readonly held: {
    (runId: RunId): HeldRun | undefined;
    (): readonly HeldRun[];
  };
  /** Show a notice through the attached host; a notice raised while no
   *  host is attached waits for the next one. */
  readonly emit: Notices['emit'];
  /** Wait until everything already sent to the session is written, shown
   *  in the view, and handled: for example, a failed run's end has been
   *  shown to the attached host (or queued for the next one). */
  readonly settled: Effect.Effect<void>;
}
```

## ModelFetch

The fetch every model request of the process's runs goes through, when the
embedder supplies one: a fake model for a test or an example, a recording
or instrumented transport. Merge it beneath `Sessions.layer` (or
`processLayer`) with `Layer.provideMerge`, so it stays in the context the
runs read; the supplied fetch then owns the proxy policy and the timeouts
too. Absent, the harness's own transport carries model traffic:
the environment's proxy policy, a project's `.env` proxy over it, and the
long-stream timeouts a streamed reasoning turn needs. A service read as an
option, not a `Context.Reference`, because that default depends on the
run's project.

```ts
class ModelFetch extends Context.Service<ModelFetch, typeof fetch>()(
  '@texra-ai/harness/ModelFetch',
)
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
   * Set when a person is present to answer the runs' requests from the
   * view (`request.decide`), as in an editor window. Absent, nobody can
   * answer until a host with an `approve` handler attaches
   * ({@link Session.attach}), so every request is denied. A session
   * resumes nothing at open either way: a run a closed or crashed process
   * left unfinished is listed as interrupted and continues on a resume.
   */
  readonly host?: Record<string, never>;
}
```

## Outcome

What the runtime answers a request with.

```ts
type Outcome = typeof OutcomeSchema.Type;
```

## OutcomeOf

What a request of kind `K` is answered with: `done` unless it is one of
the kinds above.

```ts
type OutcomeOf<K extends RuntimeCommand['kind']> = Extract<
  Outcome,
  {
    kind: K extends keyof typeof OUTCOME_KIND
      ? (typeof OUTCOME_KIND)[K]
      : 'done';
  }
>;
```

## PluginsRefused

The plugin list cannot be composed, for a defect `toolTable` refuses: an
id that is not lowercase letters, digits and dashes, an id or tool name
listed twice, a switch on a plugin with no availability probe, a
`requires` naming a plugin not listed, an agent-file block owned twice or
keyed by a persona key, or two script modules of one name.

```ts
class PluginsRefused extends Schema.TaggedError<PluginsRefused>()(
  'PluginsRefused',
  {
    message: Schema.String,
  },
)
```

## ProjectView

One project under a storage root, as `Sessions.projects` lists it.

```ts
interface ProjectView {
  /** The project's folder. */
  readonly workspace: string;
  /** Its storage directory. */
  readonly storage: string;
  readonly view: SessionView;
}
```

## responseText

The model's answer text out of a run's events, chunk by chunk as it
streams: `run.events.pipe(responseText)`.

A `stream.chunk` names only its stream, and a run streams more than its
answer: the model's thinking and what a running tool prints are chunks
too. This keeps the chunks of the streams that opened as a model response
and drops the rest. A response that arrives whole, with no chunks (a
background or non-streaming model call), comes out as its `stream.end`'s
final text. A model call that fails and is retried has already streamed
its partial answer; the retry's answer follows it.

```ts
const responseText: <E, R>(events: Stream<AgentEvent, E, R>) => Stream<string, E, R>
```

## ResumeInput

What a resume takes besides the run's id: the same custom tools the
run was started with, whether it stays open for follow-ups, and the
provider keys of the environment it resumes from.

```ts
type ResumeInput = Pick<StartInput, 'tools' | 'interactive' | 'apiKeys'>;
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
  /** The run's id, known before its first model call. */
  readonly runId: RunId;
  /** The commit of the activation this handle is for: the one `start` or
   *  `resume` opened, or the running one a resume of a live run answers.
   *  {@link LocalSession.run} rebuilds the handle from it. */
  readonly activation: CommitOrdinal;
  /** Set when you resumed a child run that its parent was still waiting
   *  on: the parent resumes instead (this handle is the parent's), and
   *  this names the child you asked for. */
  readonly redirectedFrom?: RunId;
  /**
   * How this activation ended: the end it stored, whatever its outcome. A
   * failed run's end carries its classified `error`, a stopped one's is
   * `cancelled`. It fails with {@link RunFailure} only when the activation
   * stored no end that can be read. It arrives once the session view shows
   * that end, so a view read afterwards includes it.
   */
  readonly result: Effect.Effect<RunEnd, RunFailure>;
  /**
   * The session view while this run lasts: from the first snapshot that
   * shows the run to the first that shows its stored outcome. It cannot
   * fail; if the code that maintains the view crashes, that is a defect.
   */
  readonly view: Stream.Stream<SessionView>;
  /**
   * What the run does as it does it: streamed text, tool calls, stages,
   * usage. Pipe it through `responseText` for just the answer's text.
   * Ends when the run ends, and fails as {@link result} does. Read it as
   * often as you like and whenever you like: each read is this activation's
   * events read back from the session, from the activation's start, and
   * stopping early stops your reading, not the run. A stream that ended
   * before the read reached it arrives whole, as one chunk.
   */
  readonly events: Stream.Stream<AgentEvent, RunFailure>;
}
```

## RunDeletion

What `Session.deleteRuns` did with the runs it was asked for.

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

A run that failed on its own: an activation with no readable end.
`cause` is exactly what the launch path threw.

```ts
class RunFailure extends Schema.TaggedError<RunFailure>()('RunFailure', {
  cause: Schema.Defect(),
  message: Schema.String,
})
```

## RunRecords

One run's committed records (`Session.records`), read from the session's
store as of each call. A run that never existed or was removed reads as
absent: no config, no end, nothing to resume. A read fails with the
store's error, or, on a session another process holds, with why that
process did not answer.

```ts
interface RunRecords {
  /** Its `run.start` is still listed. */
  readonly exists: () => Effect.Effect<boolean, Error>;
  /** Its saved setup; null for a run that saved none (not an agent's). */
  readonly readConfig: () => Effect.Effect<AgentConfig | null, Error>;
  /** The report its agent wrote, or null. */
  readonly readReport: () => Effect.Effect<string | null, Error>;
  /** Its terminal fact (outcome, error, output, usage), or null while it
   *  has not ended. */
  readonly readRunEnd: () => Effect.Effect<RunEnd | null, Error>;
  /** Its result as delivered: the terminal fact with the output its
   *  delivery reported, or a background command's own record. */
  readonly readResult: () => Effect.Effect<RunResult | null, Error>;
  /** The workspace files its settled calls edited that are still there,
   *  under its working directory, by path. */
  readonly readWorkspaceFiles: () => Effect.Effect<
    readonly RunWorkspaceFile[],
    Error
  >;
  /** The skills its latest step listed. */
  readonly readSkills: () => Effect.Effect<readonly string[], Error>;
  /** Its rows hold a point it continues from, ownership aside; rows that
   *  cannot be read (logged) hold none. */
  readonly readResumable: () => Effect.Effect<boolean, Error>;
  /** Why a resume of it here is refused before its agent is checked
   *  (`finished`, `earlierBuild`, `unusableCheckpoint` or
   *  `pluginUnavailable`), or null when it may go ahead; a fact that could
   *  not be read right now fails. */
  readonly readRejection: () => Effect.Effect<ResumeRefusal | null, Error>;
  /** Its conversation as every conversation view renders it. */
  readonly readConversation: () => Effect.Effect<readonly ExportNode[], Error>;
  /** Its exported trace: its display rows and its record. */
  readonly readTrace: () => Effect.Effect<AssembleTraceResult, Error>;
}
```

## RunStopReason

Why a run stops: a `user` stop or this process's `shutdown`.

```ts
type RunStopReason = typeof RunStopReasonSchema.Type;
```

## Session

One workspace's runs, the view of them, its store's records, and the
hosts attached to it. `Sessions.open` gives the {@link LocalSession}
this process holds; a window connected to a background process holds a
plain `Session`, whose members that process answers.

```ts
interface Session {
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
    /** A one-off snapshot built from the store: every run's summary, and
     *  the full transcript of the runs named. */
    readonly read: (
      runIds: readonly RunId[],
    ) => Effect.Effect<SessionView, Error>;
  };
  /** One run's stored records. */
  readonly records: (runId: RunId) => RunRecords;
  /** The runs a person started (not child runs), newest first, each with
   *  its saved setup. */
  readonly listRuns: () => Effect.Effect<
    readonly AgentRunListingEntry[],
    Error
  >;
  /**
   * Delete one run, or every stored run (`'all'`), each as a `run.delete`
   * request would. A run this session is running is skipped and reported
   * as `active`.
   */
  readonly deleteRuns: (
    target: RunId | 'all',
  ) => Effect.Effect<RunDeletion, Error>;
  /**
   * Start a run. Succeeds once the run exists: it is in the view and its
   * events are flowing. A caller that does not get a {@link Run} back has
   * none running, even if interrupted halfway. A failure before then is
   * returned to you and shown to no host: an input the launch will not run
   * is a `LaunchRefused`, which for an unknown agent or model carries
   * the notice a host shows for it.
   */
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<Run, LaunchError | RunFailure>;
  /**
   * Continue a stored run from where its history stops, with the same kind
   * of handle {@link start} gives. Pass the custom `tools` it was started
   * with. A run already running or resuming here is not started again: the
   * handle of its running activation is answered, and `input` is not read.
   * A child an open call of its parent owns resumes the parent, whose
   * handle names the child (`redirectedFrom`). A run that cannot continue
   * fails with {@link ResumeRefused}, whose `reason` says why.
   */
  readonly resume: (
    runId: RunId,
    input?: ResumeInput,
  ) => Effect.Effect<Run, ResumeRefused | LaunchError | RunFailure>;
  /** Everything else you ask of the session, as one typed request
   *  (`RuntimeCommand` in `./schemas`: send a follow-up, answer an
   *  approval, stop, fork or delete a run, switch its model, and so on).
   *  Answered exactly once, with the outcome its kind is answered with
   *  (`OutcomeOf`) or a {@link RequestError}. A decision a request's kind
   *  does not take is `Rejected`. */
  readonly request: <R extends RuntimeCommand>(
    request: R,
  ) => Effect.Effect<OutcomeOf<R['kind']>, RequestError>;
  /** Attach `host` until the caller's scope closes: it shows notices, and
   *  its `approve` answers the runs' approval requests. A session has one
   *  host at a time; attaching a second while one is attached is a defect. */
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
  | DatabaseOpenFailed
  | DatabaseReadFailed
  | SessionOptionsConflict;
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
     * Refuse new runs, stop the ones it owns, cascading, and wait for them
     * within the close budget; report the ones still live abandoned, flush,
     * release.
     */
    readonly close: (
      roots: WorkspaceRoots,
    ) => Effect.Effect<SessionCloseReport>;
    /** A process shutdown's close: drain what the plugins' pollers
     *  admitted, then close every open session at once, under one
     *  deadline. */
    readonly closeAll: Effect.Effect<readonly SessionCloseReport[]>;
    readonly list: Effect.Effect<readonly LocalSession[]>;
    /**
     * Every project under the process's storage root, from the record a
     * host writes as it opens one: a session this process holds answers
     * from its live view, any other is read cold from its store. A store
     * that cannot be read is logged and left out.
     */
    readonly projects: Effect.Effect<
      readonly ProjectView[],
      DatabaseReadFailed
    >;
  }
>()('@texra-ai/harness/Sessions')
```

## StartInput

What starting a run takes: the start as data (`StartRequestSchema`:
an agent and its instruction, or a resolved `config`, with the optional
`runId`, `continues`, `helperModel`, `approval` and `interactive`), and
the run's own tools.

```ts
type StartInput = typeof StartRequestSchema.Type & {
  /** Tools for this run only, made with `defineTool`. A resume needs the
   *  same tools passed again. */
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

## WorkspaceRoots

One workspace's host services: its folder, storage, configuration and
state stores, as the session opened over it holds them.

```ts
interface WorkspaceRoots {
  /** Canonical physical workspace root, or undefined when no folder is open. */
  readonly workspace: string | undefined;
  /**
   * The storage root this process opened (a host's per-user directory, an
   * SDK embedder's `storageDir`): every storage path below derives from it, and
   * the files a person keeps there (the MCP config, their skills and the
   * `AGENTS.md` a workspace without one falls back to) are found in it.
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
