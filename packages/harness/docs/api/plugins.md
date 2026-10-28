# `@texra-ai/harness/plugins`

<!-- Generated from `packages/harness/src/plugins.ts` by `npm run docgen`; do not edit. -->

Built-in plugins (`harnessBuiltins`) and the plugin authoring surface for
`@texra-ai/harness`.

> **Guide:** Read [Plugins, Tools & Codemode](/api/plugins-and-codemode) for
> how to author tools and plugins, how step-pinned catalogs work, and how the
> `script` (Codemode) sandbox replays across crashes.

### Key exports by role

- **Built-in plugins**: [`harnessBuiltins`](#harnessbuiltins) bundles
  [`codemode`](#codemode), [`fileOps`](#fileops), [`goal`](#goal),
  [`memoryWorkflow`](#memoryworkflow), [`multiAgent`](#multiagent)
  ([`AGENT_TOOL_NAME`](#agent_tool_name)), and [`web`](#web) for
  `Sessions.layer({ platform, plugins })`.
- **Plugin & tool authoring**: [`definePlugin`](#defineplugin),
  [`executed`](#executed), [`errorResult`](#errorresult),
  [`ToolError`](#toolerror), [`nullishWithDefault`](#nullishwithdefault),
  [`resolveToolPath`](#resolvetoolpath), and file-edit approval helpers
  ([`requestToolEditApproval`](#requesttooleditapproval),
  [`buildApprovalRejectedResult`](#buildapprovalrejectedresult),
  [`approvedWriteConflict`](#approvedwriteconflict)).
- **Runtime callbacks inside a tool**: [`requireRun`](#requirerun),
  [`callerRun`](#callerrun), [`ChildRuns`](#childruns), and
  [`RunInbox`](#runinbox).
- **Lifetimes, prompt sections & durable rows**:
  [`ALWAYS_AVAILABLE`](#always_available), [`PromptSection`](#promptsection),
  [`ProcessPluginLayer`](#processpluginlayer),
  [`SessionPluginLayer`](#sessionpluginlayer), [`PluginHold`](#pluginhold),
  [`RequestDecisionHook`](#requestdecisionhook), [`PluginArm`](#pluginarm),
  and [`AgentBlock`](#agentblock) ([`agentBlockOf`](#agentblockof)).

## AGENT_TOOL_NAME

The tool that runs a named agent as a child of the calling run.

```ts
const AGENT_TOOL_NAME: "agent"
```

## AgentBlock

A top-level block a plugin owns in an agent file (such as `task:`). The
catalog scan checks a file's block against `schema`
and keeps the parsed value on the entry (`AgentEntry.blocks`); a file
whose block fails it, or that holds a key no listed plugin owns, is
refused like any other invalid definition. An agent with a block is a
task: it declares no tools, delegation marks it for the tools that
`launchesTasks`, and it runs as one only through a launch its plugin
builds (a `script` of kind `recipe`). The harness reads nothing inside it.

```ts
interface AgentBlock<A = unknown, R = unknown> {
  /** The key in an agent file: unique across the plugin list, and never a
   *  key of the persona itself. */
  readonly key: string;
  /** The block as written, to its value with defaults applied. */
  readonly schema: Schema.Codec<A, unknown>;
  /** How a run of this block's recipe reads to whoever launched it. */
  readonly result?: AgentBlockResult<R>;
}
```

## agentBlockOf

The value of `block` on `entry`, as the catalog scan parsed it with the
block's schema; undefined when the agent has none.

```ts
function agentBlockOf<A>(
  entry: Pick<AgentEntry, 'blocks'>,
  block: AgentBlock<A>,
): A | undefined
```

## AgentBlockResult

How a recipe's return value (its run's `output.structured`) reads: to the
launching model, and to a script's summary of the files its calls wrote.
The harness reads the value only through these.

```ts
interface AgentBlockResult<R = unknown> {
  /** Checks the value where it is read; a value that fails it is delivered
   *  as an invalid result naming the issue, never shaped. */
  readonly schema: Schema.Codec<R, unknown>;
  /** The delivery body inside the harness's own result envelope. */
  delivery(value: R, runId: RunId): readonly string[];
  /** The files the recipe wrote, in the order it wrote them (a document
   *  revised twice appears twice, the later entry its latest): the files a
   *  parent may read of its child's storage, and a script's summary. */
  changes(
    value: R,
    roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  ): readonly RecipeChange[];
}
```

## AgentTrace

Agent-general SDK surface. Every method ultimately reduces to `emit()` so
the trace channel is a single source of truth. App-specific helpers are
plain functions over this interface (see `helpers.ts`).

```ts
interface AgentTrace {
  // ─── SSoT primitives ────────────────────────────────────────────────
  emit(event: AgentEvent): void;

  // ─── Plain logging (sugar over emit) ────────────────────────────────
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;

  // ─── Stage + stream handles ─────────────────────────────────────────
  openStage(label: string, options?: StageOptions): StageHandle;
  /**
   * Open a streaming message. `stream.start` marks the moment the phase the
   * stream represents actually began — emit it at the provider's phase
   * signal, or use `deferStart` when the first content chunk is the only
   * signal — so subscribers can surface liveness ("thinking…", "responding…")
   * from the start event alone.
   */
  openRun(kind: MessageType, options?: StreamOptions): StreamHandle;
  /**
   * Open a tool call's card with its first log (`tool.start`). A log whose
   * status is already terminal opens and closes the card at once; one without
   * a status, or `in_progress`, leaves it open for `update`.
   */
  openToolCard(log: ToolUseLog): ToolCardHandle;
}
```

## ALWAYS_AVAILABLE

A plugin that is probed but needs nothing installed: always available.

```ts
const ALWAYS_AVAILABLE: ToolAvailabilityChecks
```

## ApprovedEditConflictError

The approved edit no longer applies: the file changed on disk while the
edit waited for approval (another run, a subagent, the user's editor), and
the approved change overlaps a change made to that version, or the
file was deleted or created meanwhile. Nothing was written.

```ts
class ApprovedEditConflictError extends ToolError
```

## approvedWriteConflict

{@link writeApprovedContent} for a caller that reports each file's
outcome: a conflict is the value, every other failure stays one.

```ts
function approvedWriteConflict(
  path: string,
  original: string | null,
  finalContent: string,
)
```

## assertNoParentTraversal

Fail when a raw tool path contains a parent-directory segment.

```ts
const assertNoParentTraversal: (targetPath: string) => Effect<void, ToolError, never>
```

## BoundModel

One bound model: the llm `Model` and the facts of its binding the run
reads. Everything else a binding needs (its credential, its reasoning
choice, the toggles it was bound under) stays inside model access.

```ts
interface BoundModel {
  /** The run's model string (`provider/id[@effort][+pro]`), as its rows name it. */
  readonly modelId: string;
  /** The backend its `run.config` records. */
  readonly backend: ModelBackend;
  /**
   * The config the model runs and bills with on its route: its window, its
   * prices, and the media its route carries (`capabilities`).
   */
  readonly config: ModelConfig;
  readonly model: Model;
  readonly origin: ModelOrigin;
  /** The route decision this binding carries out. */
  readonly route: ModelRoute;
  /** Automatic retries after a failed attempt, read with the binding. */
  readonly automaticRetries: number;
  /** Bound for a text-only persona, with the model's whole output budget; a
   *  rebinding keeps it. */
  readonly textOnly: boolean;
  /** The route can be told to call one named tool. */
  readonly forcedToolChoice: boolean;
  /** One connection a failed turn invalidates (the Responses WebSocket). */
  readonly persistentConnection: boolean;
  /** The service tier and subscription plan pricing bills, where the route names them. */
  readonly billing: { readonly serviceTier?: 'fast'; readonly plan?: string };
  /** The retry gate's routes: the model on its wire route, then the wire route. */
  readonly routes: readonly [RoutePolicy, RoutePolicy];
  /** How the next turn is delivered, from the live toggles. */
  readonly delivery: Effect.Effect<TurnRequest['mode'], StateReadFailed>;
  /** The subscription access token the binding sends: what a renew names. */
  readonly subscriptionToken?: string;
}
```

## buildApprovalRejectedResult

```ts
function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  refusal: RefusalDecision,
): ToolResult
```

## buildFileAttachment

Build a tool attachment by reading a workspace file and packaging metadata.

```ts
const buildFileAttachment: (args_0: BuildFileAttachmentOptions) => Effect<{ readonly [x: string]: unknown; readonly path: string; readonly mimeType: string; readonly description?: string | undefined; readonly digest?: string | undefined; readonly base64Data?: string | undefined; readonly bytes?: Uint8Array<ArrayBuffer> | undefined; }, ToolError, FileSystem | ToolContext>
```

## BuildFileAttachmentOptions

```ts
interface BuildFileAttachmentOptions {
  /** Path to a workspace file (relative or absolute) */
  filePath: string;
  /** Optional description surfaced to the model */
  description?: string;
  /** Override detected MIME type */
  mimeType?: string;
  /**
   * Pre-resolved path. When provided, skips the internal resolveToolPath()
   * call — use this to avoid double-resolution when the caller already
   * resolved the path (e.g. ReadTool).
   */
  resolved?: ToolPathResolution;
}
```

## buildTemplatePassthrough

Render the fixed runtime template variables as literal `{{ TOKEN }}` text.

Agent-creation templates render once when a YAML file is produced, then the
generated agent renders again at runtime. These tokens must pass through the
creation render literally so the runtime render can substitute them later.
A plugin's own variables are not in this fixed list; `throwOnUndefined`
stays disabled, so a template tolerates their absence.

```ts
function buildTemplatePassthrough(): Readonly<Record<string, string>>
```

## CALL_FIELDS

The fields every child launch takes beside its own: memories, the call's
reuse id and card label, its time limit, and whether a script waits.

```ts
const CALL_FIELDS: { memories: decodeTo<toType<$Array<String>>, optional<NullOr<$Array<String>>>, never, never>; working_directory: decodeTo<optional<String>, optional<NullOr<String>>, never, never>; id: optional<NullOr<String>>; label: optional<NullOr<String>>; timeoutMs: optional<NullOr<Int>>; background: optional<NullOr<Boolean>>; }
```

## callerRun

The run the current call works for; none for a standalone host call.

```ts
const callerRun: Effect.Effect<ToolRun | undefined, never, ToolContext>
```

## CallRequests

The requests one tool call raises, opened through its run's loop. Each
carries an id its attempt derives, so a person's pending approval outlives
the process that asked: a resume re-enters the call, and the call opens
that same request again, joining it instead of asking twice.

```ts
interface CallRequests {
  /** The id the call's next request of `kind` opens under: the request a
   *  resumed call left standing, when it is of this kind, else the
   *  attempt's next derived id. A request is staged under this id before
   *  it opens. */
  readonly nextId: (kind: PermissionPayload['kind']) => string;
  /** Open the request (or re-enter the standing one) and wait for its
   *  decision, as `SessionRequests.ask` does. */
  readonly open: (
    payload: PermissionPayload,
  ) => Effect.Effect<RequestDecision, DatabaseNotOwner | CellError>;
}
```

## CallServices

The runtime's services a call reads: the process's, the rooted
filesystems of the session the call works in, and the call
(`ToolContext`, the run included). A tool takes `WorkspaceFs` from
context instead of resolving a static against whichever roots its fiber
happens to carry.

```ts
type CallServices =
  ProcessServices | ToolContext | WorkspaceFs | StorageFs | Scope.Scope;
```

## CellError

What a run cell's commits and re-reads fail with.

```ts
type CellError =
  RunHistoryRefused | DatabaseWriteFailed | DatabaseReadFailed;
```

## ChildLaunch

One child launch as the shared core runs it: the agent and its prompt,
the files a task works over (empty for a chat), and the recipe a task's
run opens on. `tool` names the launching tool in its reuse key and its
copy.

```ts
interface ChildLaunch {
  readonly tool: string;
  readonly agentName: string;
  /** An agent the call defines, named `agentName`: no catalog entry. */
  readonly persona?: AgentProposal['persona'];
  readonly prompt: string;
  readonly model: string | null | undefined;
  readonly schema: Record<string, unknown> | null | undefined;
  readonly memories: readonly string[];
  readonly workingDirectory: string | null | undefined;
  readonly id: string | null | undefined;
  readonly timeoutMs: number | null | undefined;
  readonly background: boolean | null | undefined;
  readonly files: {
    readonly inputFiles: readonly string[];
    readonly contextFiles: readonly string[];
    readonly mediaFiles: readonly string[];
    readonly outputFiles: readonly string[];
  };
  /** A task: the child opens on what the launching plugin builds for the
   *  approved agent (its recipe and outputs; null for an agent with no task
   *  block); the proposal says it works over `files` with `options`. */
  readonly task: {
    readonly configFor: (
      chosen: AgentProposal,
    ) => Pick<AgentConfig, 'script' | 'outputFiles'> | null;
    readonly options: NonNullable<AgentProposal['options']>;
  } | null;
}
```

## ChildRunDelivery

One child-run delivery: the envelope's identity followed by the facts its
driver selected. Every fact is optional; the body renders those present, in
the fixed order declared below, so two drivers reporting the same fact
always render it the same way and in the same place.

```ts
interface ChildRunDelivery {
  /** Root element name (`subagent-result`, `background-error`, …). */
  readonly tag: string;
  readonly runId: string;
  /** Echoed prompt attribute, for a child that took a prompt; truncated before escaping. */
  readonly prompt?: string;
  /**
   * Attributes rendered after id/prompt (`agent`, `status`, `thread-id`, …).
   * Null/undefined values are dropped by the envelope.
   */
  readonly attributes?: readonly {
    readonly name: string;
    readonly value: string | number | boolean | null | undefined;
  }[];
  /** Pre-rendered wall-time body text (`1.2s`). */
  readonly wallTime?: string;
  /** Final assistant response as one inline element; empty → `(no response)`. */
  readonly response?: string;
  /** Token usage element; omitted when null/undefined. */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  } | null;
  /** Pre-rendered fact lines appended after the shared elements. */
  readonly lines?: readonly string[];
  /** Failure text; its presence is what makes this delivery an error report. */
  readonly message?: string;
}
```

## ChildRunPause

A stopped child's pause: the notice its parent reads, and the id a
tool call names to continue it (a Codex thread, a Claude session), which
the `child.park` row keeps so that call reactivates this same run.

```ts
interface ChildRunPause {
  readonly text: string;
  readonly resumeId?: string;
}
```

## ChildRuns

The door, as the run loop provides it beside each call ({@link childRuns});
outside a run it is the refusal, which is the reference's default.

```ts
const ChildRuns: Reference<ChildRunsShape>
```

## ChildRunsShape

A plugin tool's one door to the session's runs. It launches children of
its call's run: an agent's (`launch`: the child's settled result, or its
receipt for a background launch, within the issuing script's concurrency
budget) or an external process's (`launchProcess`: its run id, outside
the budget); a plugin's tool reaches no other launch. And it reaches a
run of the session by id: its input, live parent edge, records and
rows. Each needs the call's run; a standalone host call has none.

```ts
interface ChildRunsShape {
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
  /** Its committed rows, with `types` only those. */
  readonly rows: (
    runId: RunId,
    types?: readonly SessionEvent['type'][],
  ) => Effect.Effect<readonly SessionEvent[], Error>;
}
```

## ChildStrategyBase

What every child strategy says of its turns; `R` names the services a
turn reads, forwarded to the loop's caller.

```ts
interface ChildStrategyBase<TTurn, R> {
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;
  /** A turn that did not throw but reports an error (an SDK error result). */
  isTurnError?(turn: TTurn): boolean;
  /** The error message to log for a non-throwing failure, if it has one. */
  turnErrorMessage?(turn: TTurn): string | undefined;
  /** The success delivery XML: an Effect over `R`, since a recipe-run
   *  subagent writes its diff files on the way. */
  formatDelivery(
    turn: TTurn,
    wallTimeMs: number,
  ): Effect.Effect<string, Error, R>;
  /** The error delivery XML (turn is null when the call threw). */
  formatError(turn: TTurn | null, err: unknown, wallTimeMs: number): string;
  /** The result manifest persisted beside each turn's report, success or
   *  failure (`turn` null when the call threw), so a failure overwrites a
   *  stale interim one. */
  buildResultMeta?(
    turn: TTurn | null,
    isError: boolean,
    wallTimeMs: number,
  ): Effect.Effect<ResultMeta | undefined, Error, R>;
}
```

## codemode

Code mode: the `script` tool, a program that calls the run's other tools,
and `self()`, the function a script runs this agent again with. An agent
gets them if its configuration names `script`, or, while script-only
tools are on, as every chat run does; its session layer is the code
sandbox the scripts run in.

```ts
const codemode: Plugin
```

## definePlugin

A plugin value from its definition, its own services erased.

```ts
const definePlugin: <ROut = never>(
  plugin: PluginDefinition<ROut>,
) => Plugin
```

## DefineToolOptions

```ts
type DefineToolOptions<T, R = never> = Required<
  Pick<ToolDefinition, 'name' | 'description'>
> &
  Pick<ToolDefinition, 'scriptReturns' | 'card'> &
  Pick<
    ITool,
    | 'unavailableHosts'
    | 'hostCapability'
    | 'launchesTasks'
    | 'lane'
    | 'scriptGlobal'
    | 'replay'
    | 'requiresApproval'
    | 'slow'
    | 'describe'
  > & {
    /** Decodes the model's input into `T`. */
    schema: Schema.Codec<T, unknown>;
    /**
     * What the run loop checks before this tool's body runs: the paths the
     * call writes and the command it must get approved. Declared here,
     * applied once in `agent/runtime/loop/toolGuard.ts`.
     *
     * `NoInfer<R>`: the guard is checked against the requirement channel the
     * tool already has, it never sets it.
     */
    guard?: ToolGuard<T, NoInfer<R>>;
    /** The run body. Succeed with the text the model reads back, or with a
     *  whole `ToolResult` for a summary, attachments or facts; fail with
     *  an `Error` and the model reads its message as the tool's error. */
    execute: (input: T) => Effect.Effect<ToolResult | string, Error, R>;
  };
```

## EditRecord

```ts
type EditRecord = typeof EditRecordSchema.Type;
```

## errorResult

Build a `status: 'error'` result literal. Reserved for call sites that
cannot use the dominant `throw new ToolError(...)` convention (caught
centrally by `defineTool`'s `call`) — typically because the caller must keep
running after emitting a partial per-item error, or because a nested try/catch
would otherwise reformat the thrown message. Prefer `throw new ToolError(...)`
over this helper whenever the call site can support it.

```ts
function errorResult(
  error: string,
  extra?: Omit<Extract<ToolResult, { status: 'error' }>, 'status' | 'error'>,
): Extract<ToolResult, { status: 'error' }>
```

## executed

Build a `status: 'executed'` result. `summary` is omitted when not given,
matching the many call sites that only ever set `output`.

```ts
function executed(
  output: string,
  summary?: string,
): Extract<ToolResult, { status: 'executed' }>
```

## fileList

A list of file paths, empty when the call names none.

```ts
const fileList: (description: string) => decodeTo<toType<$Array<String>>, optional<NullOr<$Array<String>>>, never, never>
```

## fileOps

Files and the shell: every agent needs them. An app passes the filter
`write_file` applies to what it writes (its own content replacements).

```ts
const fileOps: (options?: { readonly writeFilter?: WriteFilter | undefined; }) => Plugin
```

## FollowUpFailureReason

Why a submission could not be admitted, worded for the user by
{@link presentFollowUpResult}: a resume's refusal (`ResumeRefusal`; a
message to a run with no loop here is admitted only as a resume would be,
and `not_resumable` there also covers a closed input, a disposed session,
or a message that is not the user's own), or one of the message's alone:

- `read_failed`: the run's claim or state could not be read just now
  (a busy or failing store), which says nothing about the run itself.
- `one_shot`: the run's live loop ends after its current turn and reads
  no message (headless, or an in-band child), or the run has no loop of
  its own and its launch takes none (a background command).
- `not_parent`: the sender is not the run's parent.

```ts
type FollowUpFailureReason =
  ResumeRefusal | 'read_failed' | 'one_shot' | 'not_parent';
```

## FollowUpSenderInput

Who a producer says a follow-up is from. Runs talk as a graph: any run may
message any run in the project, whatever their places in the supervision
tree. A run names only itself; the recipient's admission
(`Inbox.send`) stamps how it relates to the recipient.

```ts
type FollowUpSenderInput =
  | Exclude<FollowUpSender, { readonly kind: 'run' }>
  | { readonly kind: 'run'; readonly runId: RunId };
```

## formatDelivery

Build the `<...-result>` / `<...-error>` XML delivered to the parent's
follow-up queue when a child run's turn settles.

```ts
function formatDelivery(delivery: ChildRunDelivery): string
```

## formatToolOutput

Format tool output with a header and content.

```ts
function formatToolOutput(
  header: string,
  content: string | string[] | null,
  noMatchesText: string = '(no entries)',
): string
```

## getGitignoreMatcher

Build the ignore matcher for `workspacePath` from its ignore policy files.
The root is the caller's — the `WorkspaceFs` of the session the call works
on — rather than whichever roots the calling fiber carries, so a listing
and the policy that filters it name the same workspace. Read on every call:
a process serves several projects, and each call should see the policy as
it is on disk now.

```ts
const getGitignoreMatcher: (workspacePath: string | undefined) => Effect<GitignoreMatcher, PlatformError, FileSystem>
```

## GitignoreMatcher

A workspace's ignore policy: whether a workspace-relative path is
ignored, and the policy files it was read from.

```ts
type GitignoreMatcher = {
  ignores: (relativePath: string) => boolean;
  ignoreFiles: string[];
};
```

## goal

Plans and goals: the `plan` tool proposes a plan, which the user may run
as a goal: a background script of the conversation that runs its agent
in rounds through `self()` (`goalScript`).

```ts
const goal: Plugin
```

## harnessBuiltins

Every built-in, with no app options.

```ts
const harnessBuiltins: readonly Plugin[]
```

## HostCapabilities

The host capabilities a session's host serves now (`ITool.hostCapability`
names one), by the session's storage root: what a plugin whose tools need
a host capability serves from its process layer, from the same place its
tools reach that capability, so it is offered exactly while it works.
A plugin that serves none offers its gated tools nowhere.

```ts
class HostCapabilities extends Context.Service<
  HostCapabilities,
  { readonly of: (storage: string) => ReadonlySet<string> }
>()('@texra-ai/harness/agent/HostCapabilities')
```

## InboxItem

One message a producer sends.

```ts
interface InboxItem {
  readonly text: string;
  readonly displayText?: string;
  /** A user's media (e.g. pasted images) and its blobs (`attachedMedia`). */
  readonly media?: QueuedFollowUp['content']['media'];
  readonly blobs?: readonly DraftBlob[];
  readonly from: FollowUpSenderInput;
  /** Identity of a delivery its producer may repeat (a child's result):
   *  the row's `followUpId`, so a replay writes nothing. */
  readonly deliveryId?: string;
  /** A request of the run's own (`/compact`, a model switch), not a message. */
  readonly control?: QueuedFollowUp['control'];
}
```

## isTransientHttpStatus

Whether an HTTP status code is transient (worth retrying): 408 request
timeout, 429 rate limit, or 5xx server error. Other 4xx statuses are
permanent and won't change on retry.

This is the general-purpose HTTP policy (tool fetches, tool timeouts,
device-code polling). The llm package's internal provider-error retry
policy is a separate, deliberately different policy for LLM provider SDK
errors: it also treats 409 Conflict as retryable, because a provider API's
409 usually signals a transient session/resource race, unlike a generic
HTTP 409. Don't merge the two without re-confirming that call for every
consumer.

```ts
function isTransientHttpStatus(status: number): boolean
```

## isTransportReason

A request that got no (complete) answer: nothing responded, or the
connection dropped mid-body (undici's `TypeError`, "terminated"; a
malformed body is a `SyntaxError`).

```ts
function isTransportReason(
  reason: HttpClientError.HttpClientError['reason'],
): boolean
```

## jitteredExponentialBackoffMs

Compute a jittered exponential backoff delay: `baseMs * 2^(failures-1)`,
capped at `maxMs`, then randomized by +/-20% and capped again
so jitter can never push the result past `maxMs`. Shared by every retry/
backoff loop in the codebase so the jitter formula only exists once.

`unitRandom` is the caller's uniform draw in [0, 1) — `yield* Random.next`
in the Effect callers — so a test fixes the jitter through Effect's
`Random` reference instead of stubbing the global `Math.random`.

```ts
function jitteredExponentialBackoffMs(
  baseMs: number,
  failures: number,
  maxMs: number,
  unitRandom: number,
): number
```

## JsonRpcConnection

```ts
interface JsonRpcConnection {
  readonly request: <T>(
    method: string,
    params?: unknown,
  ) => Effect.Effect<T, JsonRpcRequestError | JsonRpcConnectionDisposed>;
  /** Send a notification; after `close` it is dropped. */
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>;
  /** Fail every pending request with `reason` and refuse later ones. Idempotent. */
  readonly close: (reason: string) => Effect.Effect<void>;
  /** Completes once the reader has dispatched the input's last message. */
  readonly inputEnded: Effect.Effect<void>;
}
```

## JsonRpcConnectionDisposed

The connection was closed; `message` is the closer's reason.

```ts
class JsonRpcConnectionDisposed extends Schema.TaggedError<JsonRpcConnectionDisposed>()(
  'JsonRpcConnectionDisposed',
  { message: Schema.String },
)
```

## JsonRpcConnectionOptions

What {@link makeJsonRpcConnection} connects: the peer's byte streams,
their framing, and the owner's handlers.

```ts
interface JsonRpcConnectionOptions {
  /** The peer's output: bytes we decode. */
  readonly input: Stream.Stream<Uint8Array, Error>;
  /** The peer's input: bytes we encode. */
  readonly output: Sink.Sink<void, Uint8Array, never, Error>;
  readonly onNotification: (
    method: string,
    params: unknown,
  ) => Effect.Effect<void>;
  /**
   * `'content-length'` (the default): LSP frames. `'newline'`: one JSON
   * message per line, no embedded newlines (MCP stdio).
   */
  readonly framing?: 'content-length' | 'newline';
  /**
   * The result of a request the peer sends us, or `undefined` to refuse it
   * with `MethodNotFound`.
   */
  readonly onRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown> | undefined;
}
```

## JsonRpcRequestError

The peer answered a request with a JSON-RPC error. `code` is the JSON-RPC
error code the peer sent.

```ts
class JsonRpcRequestError extends Schema.TaggedError<JsonRpcRequestError>()(
  'JsonRpcRequestError',
  {
    method: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
)
```

## LogOptions

Sugar passed to debug/info/warn/error.

```ts
interface LogOptions {
  readonly data?: unknown;
  /** The row's category; subscribers pick a render style from it. */
  readonly messageType?: MessageType;
  /**
   * Stage to attach this entry to, for callers that captured a group id
   * earlier. Without one the entry belongs to no stage.
   */
  readonly stageId?: string;
}
```

## LogWriteError

A write the store refused: nothing was written.

```ts
type LogWriteError = DatabaseNotOwner | DatabaseWriteFailed;
```

## makeJsonRpcConnection

```ts
const makeJsonRpcConnection: (options: JsonRpcConnectionOptions) => Effect<JsonRpcConnection, never, Scope>
```

## MemoryPinResult

What a pin toggle did: `cap-reached` names the cap it hit.

```ts
type MemoryPinResult =
  | { readonly status: 'changed'; readonly pinnedCount: number }
  | { readonly status: 'already' }
  | { readonly status: 'cap-reached'; readonly max: number };
```

## MemoryPreview

One memory's bounded preview, with the path the memory tool shows.

```ts
interface MemoryPreview {
  readonly storagePath: string;
  readonly displayPath: string;
  readonly preview: string;
  /** Absent when the file did not fit the scan window. */
  readonly lineCount: number | undefined;
}
```

## MemoryStore

The memory tree's host-facing reads and edits, over the caller's
`StorageFs`.

```ts
const MemoryStore: { folder: "memories"; storagePath: (input: string) => Effect<string, Error, never>; displayPath: (storagePath: string) => string; list: Effect<{ readonly displayPath: string; readonly storagePath: string; readonly size: number; readonly mtime: string; readonly preview?: string | undefined; readonly lineCount?: number | undefined; readonly previewError?: boolean | undefined; readonly modifiedBy?: string | undefined; readonly pinned?: boolean | undefined; }[], PlatformError, StorageFs>; preview: (input: string) => Effect<MemoryPreview, Error | PlatformError, StorageFs>; delete: (input: string) => Effect<void, Error | PlatformError, StorageFs>; pin: (input: string, pinned: boolean) => Effect<MemoryPinResult, Error | PlatformError, StorageFs>; }
```

## memoryWorkflow

Memory and past runs: the `memory` tool, offered while memory is on,
and `executions`.

```ts
const memoryWorkflow: Plugin
```

## ModelRetryGate

Coordinates retries for model calls sharing one provider route.

Healthy routes remain fully concurrent. After a shared-route failure, calls
on the affected route wait through one shared backoff and exactly one
becomes the recovery probe. A successful probe releases the other calls;
another route failure increases the shared backoff. The gate does not decide
how many times a node retries—that remains the node retry loop's concern.

Route state is mutated only from within Effect steps on one runtime, so a
plain map is atomic here; the probe timer is a fiber in the gate's scope
that sleeps on the runtime `Clock`, and a waiting call is a `Deferred` the
probe fiber or a healthy success completes.

```ts
class ModelRetryGate
```

## multiAgent

Child agents: the `agent` tool.

```ts
const multiAgent: Plugin
```

## nullishWithDefault

An optional tool-input field whose absence resolves to `fallback` before
`execute` ever sees it.

The encoded side is `Schema.optional(Schema.NullOr(schema))`, deliberately
not `Schema.optional(schema)` with a decoding default. OpenAI-compatible
providers (DeepSeek, Kimi, …) represent an omitted optional field as an
explicit `null` in structured output, so the field must be nullable as well
as optional; `withDecodingDefault` substitutes only for an absent or
`undefined` field and would hand `null` straight through. The `?? fallback`
covers absent, `undefined` and `null` alike, which is why the decoded field
is required and not nullable, and use sites need no `== null` check of
their own.

`description` is written on the encoded side: that is the side the model's
JSON Schema is generated from, and an annotation on the decoded side of a
transformation never reaches it.

```ts
function nullishWithDefault<S extends Schema.Top>(
  schema: S,
  fallback: S['Type'],
  description: string,
): Schema.decodeTo<Schema.toType<S>, Schema.optional<Schema.NullOr<S>>>
```

## parseWorkingDirectory

Trim and validate a working_directory value. Must be absolute if provided.

```ts
function parseWorkingDirectory(
  raw: string | null | undefined,
): Result.Result<string | undefined, ToolError>
```

## PluginArm

One row kind a plugin owns (`plugin.fact`): the version it writes, the
schema of that version's value, and the adjacent upcasters (`upcasters[i]`
maps version `i + 1` to `i + 2`) the store reads an older value through.
The store checks every row of the kind against its arm, and keeps a row
whose arm the process's plugins lack (its plugin removed, or not listed
here) without reading it. Arms live beside their readers, in modules
webviews can import.

```ts
interface PluginArm {
  /** The plugin's id: an arm is its own plugin's, never another's. */
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: Schema.Codec<unknown, unknown>;
  readonly upcasters: readonly ((value: JsonValue) => JsonValue)[];
  /** The kind's own transition rule, checked by the store in the writing
   *  transaction against the aggregate's latest row of the kind (none
   *  before the first): the refusal's reason, or null to admit. */
  readonly admits?: (
    previous: PluginRow | undefined,
    next: PluginRow,
  ) => string | null;
  /** Whether the aggregate's `latest` row already says more than `next`
   *  (a call's fact that lagged behind a later writer): the call's batch
   *  then leaves `next` out instead of failing on `admits`. */
  readonly supersedes?: (latest: PluginRow, next: PluginRow) => boolean;
  /** The workspace files a row of the kind says its run wrote past the
   *  editor's own write path: every process that folds the run announces
   *  them (`workspaceFilesWritten`), a window hearing a service task's
   *  write as it hears its own. */
  readonly writes?: (value: JsonValue) => readonly string[];
}
```

## PluginDefinition

A plugin as its author writes it: its tools, layers and probe may
require `ROut`, the services its own layers serve, beside the harness's.
`definePlugin` checks that at compile time (a tool that needs a service no
layer of its plugin serves does not compile) and erases it: the table
holds every plugin alike, and the step that pins a plugin provides its
layers' services to its calls. `C`: what a tool's calls are served.

```ts
interface PluginDefinition<ROut, C = PluginToolServices> extends Omit<
  Plugin,
  'tools' | 'processLayer' | 'sessionLayer' | 'availability'
> {
  readonly tools?: Readonly<Record<string, ITool<Error, C | ROut>>>;
  readonly processLayer?: ProcessPluginLayer<ROut>;
  readonly sessionLayer?: Layer.Layer<ROut, never, PluginHold>;
  /** Probed outside any step, whether or not the plugin is on: it may
   *  require only the process's probe services. Its own process services
   *  are offered while its layer is up, read with `Effect.serviceOption`. */
  readonly availability?: ToolAvailabilityChecks;
}
```

## PluginHold

Keep the session layer that provides this service up until `until` ends:
for work a plugin starts that outlives the step that started it (an agent
CLI's detached child), so switching the plugin off does not drop state
that work still owns. The hold is taken before this returns.

```ts
class PluginHold extends Context.Service<
  PluginHold,
  (until: Effect.Effect<void>) => Effect.Effect<void>
>()('@texra-ai/harness/tools/PluginHold')
```

## PluginLayerServices

What a plugin's process layer is built over: the tool catalog it belongs
to, and the process's filesystem, paths, child processes and application
state (a language server pool spawns and reads its settings).

```ts
type PluginLayerServices =
  | ToolCatalog
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | AppState;
```

## PluginRow

One stored row of a plugin's kind, as its arm's transition rule reads
it: the row's decoded value and the run it is parented to, if any.

```ts
interface PluginRow {
  readonly value: JsonValue;
  readonly parent: RunId | null;
}
```

## PluginToolServices

Services the runtime supplies to a plugin's tool: the call's. The
child-launch door (`ChildRuns`) and the call's place in its run
(`RunCall`) are references with defaults, never requirements; a plugin's
tool reads the door and never the session's `Runs`.

```ts
type PluginToolServices = CallServices;
```

## ProcessChildLaunch

A child run an external process drives, launched from a plugin's tool:
how it reads (`identity`), its record, its task label, and the strategy
its loop runs, built around the trace of the child the launch created. With
`resumeId`, the paused child of the caller that kept that id is
activated again instead of a new run.

```ts
interface ProcessChildLaunch<TTurn> {
  readonly identity: Extract<RunIdentity, { kind: 'agent' }>;
  readonly config: AgentConfig;
  readonly description: string;
  readonly resumeId?: string;
  readonly buildLaunch: (ctx: {
    readonly logger: AgentTrace;
    readonly runId: RunId;
  }) => Effect.Effect<ProcessChildStrategy<TTurn>, Error>;
}
```

## ProcessChildStrategy

An external process's strategy (agent CLI, background bash): each turn's
result commits in the loop, which then waits for the child's next batch.

```ts
interface ProcessChildStrategy<
  TTurn,
  R = never,
> extends ChildStrategyBase<TTurn, R> {
  /** A stop interrupts the turn's fiber: a foreign call takes its signal
   *  from that interruption (`Effect.abortSignal`, `Effect.tryPromise`). */
  launch(): Effect.Effect<TTurn, Error, R>;
  /** The next turn, from the queued follow-ups. Absent: the first turn is
   *  the only one (a background shell). */
  runTurn?(
    followUps: readonly FollowUpContent[],
  ): Effect.Effect<TTurn, Error, R>;
  /** The turn a stop cut short, rebuilt from what the child buffered, and
   *  delivered: only a killed OS process, whose exit code and output are a
   *  complete result. */
  interruptedTurn?(): TTurn;
  /** A stop pauses this child rather than cancelling it: what it had done
   *  and how the parent's model continues it; undefined cancels it. */
  pauseNotice?(): ChildRunPause | undefined;
  /** After a successful turn: register the session/thread id, etc. */
  onTurnSuccess?(turn: TTurn): void;
  /** Release provider-owned registry entries; called once, before a failed
   *  or interrupted delivery or at the end. */
  releaseSessionOwnership?(): void;
}
```

## ProcessPluginLayer

A plugin's process-lifetime services (its `processLayer`): built
when the plugin is switched on or first pinned, released when it is
switched off and no step uses it. `ROut` is what it
serves its own plugin's code (`definePlugin`); the table holds it erased.
`drain` is its step of the core shutdown protocol, run before the
sessions close while its services are still up.

```ts
interface ProcessPluginLayer<ROut = never> {
  readonly layer: Layer.Layer<ROut, never, PluginLayerServices>;
  readonly drain?: Effect.Effect<void, never, ROut>;
}
```

## PromptSection

A plugin's section of each request's system text, rendered from the tool
names the request's step offers, whether the run is a child and its
workspace configuration ('' for none).

```ts
type PromptSection = (ctx: {
  readonly offered: readonly string[];
  readonly isChild: boolean;
  /** The step's bound model is an Anthropic model. */
  readonly isAnthropic: boolean;
  /** The run's workspace configuration, for a section that follows a
   *  setting of its plugin's. */
  readonly config: ConfigProvider;
}) => string;
```

## randomizedExponentialBackoff

```ts
function randomizedExponentialBackoff(base: Duration.Input)
```

## RecipeChange

One file a recipe wrote, as a script summary counts it.

```ts
interface RecipeChange {
  /** The workspace path the file replaces. */
  readonly path: string;
  /** The file the recipe wrote. */
  readonly absolutePath: string;
  /** The file it was diffed against, when it continues one: an earlier
   *  call's `absolutePath` continues that call's row. */
  readonly base: string | null;
  readonly added: number | null;
  readonly removed: number | null;
}
```

## RefusalDecision

The arms that decline a request, whatever the provenance.

```ts
type RefusalDecision = Extract<
  RequestDecision,
  { action: 'reject' | 'deny' | 'cancel' }
>;
```

## refusalOf

A decision that is not one the caller accepts, read as the refusal it is
or, for an arm the request's kind never offered (a surface defect), as a
loud denial naming it: a run never proceeds on an answer it cannot read.

```ts
function refusalOf(
  kind: PermissionPayload['kind'],
  decision: RequestDecision,
): RefusalDecision
```

## renderPrompt

Render a prompt string using nunjucks templating.

- `@param` prompt The prompt template string
- `@param` variables Variables to use in template rendering
- `@returns` The rendered prompt; a template error fails with that `Error`

```ts
const renderPrompt: (prompt: string, variables: Record<string, unknown>) => Effect<string, Error, never>
```

## RequestDecisionHook

A plugin's side of a decision on a pending request of the kind it owns
(the external inquiry's answer, recorded on its cross-project thread). The
session runs it before the decision's row commits, under the request's
decision lane, so a process that exits in between leaves the request
pending and answerable rather than settled with nothing recorded. It may
send a run of the session its input (`inbox`), and commit facts about its
own aggregates, hung under the request's run (`commit`).

```ts
interface RequestDecisionHook {
  /** The request kind whose decisions this plugin records. */
  readonly kind: PermissionPayload['kind'];
  readonly record: (request: {
    readonly payload: PermissionPayload;
    readonly decision: RequestDecision;
    readonly inbox: (runId: RunId) => RunInbox;
    readonly commit: (
      facts: readonly (ToolFact & { readonly aggregate: string })[],
    ) => Effect.Effect<void, LogWriteError>;
  }) => Effect.Effect<void, Error, GlobalValues>;
}
```

## requestToolEditApproval

Ask the person for an edit: policy first (allow, deny), else a
`request.opened` on the run with its content held in the session's
tool-edit store, serialized behind the run's other prompts, answered by a
surface's `request.decide`. An approve applies the file as the user left
it: the decision's content, else the edit a surface recorded, else the
proposal.

```ts
const requestToolEditApproval: (request: ToolEditProposal) => Effect<ToolEditApprovalResult, Error, ToolContext>
```

## requireRun

The current call, narrowed to one made under a run, or the shared refusal:
the one place it is worded, so the model reads the same sentence whichever
tool it reached for. `toolName` names what needs the run, which can be
narrower than the tool (`'bash run_in_background'`).

```ts
const requireRun: (toolName: string) => Effect<ToolContextShape & { readonly run: ToolRun; readonly requests: CallRequests; }, ToolError, ToolContext>
```

## resolveToolPath

Resolve a tool path, relative or absolute, against the call's working
directory when the run has one and its workspace folder otherwise.

A path that escapes that root is admitted only inside a registered external
root or with path protection switched off; otherwise it fails with a
`ToolError` the tool runner reports to the model. With no folder open and
no working directory, only an absolute path can resolve (the agent
directories are registered external roots).

`fsPath` is workspace-relative for a workspace path, so the confined
`WorkspaceFs` view answers it, and absolute for a working-directory or
outside path.

```ts
function resolveToolPath(
  call: ToolPathCall,
  targetPath?: string,
): Effect.Effect<ToolPathResolution, Error>
```

## retryTransientFetch

Run `request` under a per-attempt deadline, retrying only transient
failures (timeout, transport failure, 408/429, 5xx) with exponential
backoff and full jitter — the pattern every network-boundary tool (web
fetch/search, Loogle) repeats. Any other failure — a non-transient HTTP
status, a response-shape or size-limit failure reported by `request` — ends
the retry immediately and is the program's failure. Interruption stops both
the active attempt and the backoff sleep.

```ts
const retryTransientFetch: <T, E extends Error, R>(request: Effect<T, E, Scope | R>, options: RetryTransientFetchOptions<E>) => Effect<T, E | TimeoutError, Exclude<R, Scope>>
```

## RetryTransientFetchOptions

How {@link retryTransientFetch} retries: its retry count, base backoff,
per-attempt deadline and transient-failure observer.

```ts
interface RetryTransientFetchOptions<E> {
  /** Retries after the first attempt. */
  readonly retries: number;
  /**
   * Base backoff before the first retry; doubles per retry, then scaled by
   * a uniform factor in [1, 2) — see {@link randomizedExponentialBackoff}.
   */
  readonly minTimeout: number;
  /** Deadline for each attempt, connection and body read included. */
  readonly timeoutMs: number;
  /**
   * Observes each transient failure — the attempts the schedule may retry,
   * the last exhausted one included. A permanent failure ends the retry
   * unobserved, since it never had retries left to report.
   */
  readonly onFailedAttempt?: (
    error: E | Cause.TimeoutError,
    retriesLeft: number,
  ) => Effect.Effect<void>;
}
```

## RouteFailure

A failure a route classifies as its own, with the wait it asks for.

```ts
interface RouteFailure {
  readonly retryAfterMs?: number;
}
```

## RouteOptions

How a call waits on its routes: the base backoff, and who hears a wait.

```ts
interface RouteOptions {
  readonly baseBackoffMs: number;
  readonly onWait?: (delayMs: number) => void;
}
```

## RoutePolicy

```ts
interface RoutePolicy {
  readonly key: string;
  readonly classifyFailure: (error: Error) => RouteFailure | undefined;
  readonly isReachableFailure?: (error: Error) => boolean;
}
```

## RunFileService

```ts
class RunFileService
```

## RunHistoryInconsistent

```ts
class RunHistoryInconsistent extends Schema.TaggedError<RunHistoryInconsistent>()(
  'RunHistoryInconsistent',
  {
    reason: Schema.Literals([
      'out-of-order', // commits not strictly increasing, or a row before the row it needs
      'orphan-settlement', // a tool.result for no pending call
      'unknown-run-row', // an unrecognized type on the run aggregate
      'mismatched-delivery', // a delivering append does not match its response's results
      'unreadable-turn', // a stored turn this build of the package cannot parse
    ]),
    detail: Schema.String,
    commit: Schema.NullOr(CommitOrdinalSchema),
  },
)
```

## RunHistoryRefused

A refusal the run history itself decided. Database failures are kept OUT of
this type: reporting a disk error as a stolen claim is the silent-
degradation defect in a different costume, so `open` and `load` keep
them in their error channel beside it.

Which arms are reachable, and from where:
- `not-owner`: from a resume's `open`, where the claim proves prior owners
  dead before moving and a live foreign owner is the
  `DatabaseClaimRefused` verdict it fails with (a claim taken after that
  proof is `DatabaseNotOwner`); and from `RunCell.append`,
  where the session's log refuses a target this process no longer
  holds open as `DatabaseNotOwner`, nothing written. It is never
  synthesised from any other write failure: a disk error stays a
  `DatabaseWriteFailed`. A loop that meets it mid-turn stops with it,
  no retry and no second write.
- `unsafe-endpoint`: a pre-publish assertion over every durable origin,
  the loud restatement of the package's endpoint constraint.
- `unprepared-history`: `PreparedHistorySchema` over the history the batch
  assembles, at the write boundary of every batch that appends to or
  rewrites it, and on cold load.
- `inconsistent`: the rows cannot be applied; `cause` says why. From
  `load`, and from `RunCell.append` before it publishes: a batch is applied
  first and refused with nothing committed, because a published row the
  row handlers reject is a run no later `load` can read.
A violated `RunCell.append` precondition is a caller defect
(`Effect.die`), not an arm: the loop must not handle it.

```ts
class RunHistoryRefused extends Schema.TaggedError<RunHistoryRefused>()(
  'RunHistoryRefused',
  {
    reason: Schema.Literals([
      'not-owner',
      'unsafe-endpoint',
      'unprepared-history',
      'inconsistent',
    ]),
    runId: RunIdSchema,
    detail: Schema.String,
    cause: Schema.optional(RunHistoryInconsistent),
  },
)
```

## RunInbox

One run's input, as a plugin reaches it: what it sends the run (routed,
admitted and woken as {@link submitFollowUp} does), and when the run
takes no more.

```ts
interface RunInbox {
  /** Deliver `item` to the run. */
  readonly send: (
    item: InboxItem,
    options?: RunInboxSendOptions,
  ) => Effect.Effect<SubmitFollowUpResult, Error>;
  /** Hear the run take no more input, or its session's inbox close;
   *  returns the detach. */
  readonly onClosed: (listener: () => void) => () => void;
}
```

## RunInboxSendOptions

How one input is delivered to a run.

```ts
interface RunInboxSendOptions {
  /** A notification for a generation already running: read at a turn's
   *  end, never resuming the run (`readableMessages`). */
  readonly hold?: 'generation';
  /** Only from the run's parent, by its rows (`SendOptions.fromParent`). */
  readonly fromParent?: boolean;
}
```

## RunStorageEntry

One run-relative entry of a run's storage, read without following a link.

```ts
type RunStorageEntry =
  | { readonly kind: 'file'; readonly location: RunStorageFileLocation }
  | {
      readonly kind: 'symlink' | 'directory' | 'unsupported';
      readonly absolutePath: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };
```

## scopedClient

The process client for one attempt under {@link withRequestTimeout}: the
attempt's scope aborts its requests. Every tool request takes its client
from here or {@link scopedOkClient}.

```ts
const scopedClient: Effect<With<HttpClientError, Scope>, never, HttpClient>
```

## scopedOkClient

{@link scopedClient} where a non-2xx status fails with a `StatusCodeError`.

```ts
const scopedOkClient: Effect<With<HttpClientError, Scope>, never, HttpClient>
```

## senderOf

The sender a tool call speaks as: its run, or the user when no run
calls it.

```ts
function senderOf(caller: RunId | undefined): FollowUpSenderInput
```

## SessionPluginLayer

A plugin's session-lifetime services (its `sessionLayer`): one build
per open session, up while the plugin is switched on, a step of that
session pins it, or work it started holds it (`PluginHold`), and closed
with the session. It reads no run: a plugin reaches runs through its
tools' `ChildRuns`.

```ts
type SessionPluginLayer = Layer.Layer<never, never, PluginHold>;
```

## StageHandle

Handle returned by `openStage` — wraps a stage with end/child ops.

```ts
interface StageHandle {
  /** Stage id. */
  readonly id: string | undefined;
  /** Emit `stage.end` with the given outcome. Idempotent. */
  end(status?: RunOutcome): void;
  /** Open a nested stage parented to this one. */
  child(label: string, options?: StageOptions): StageHandle;
}
```

## StageOptions

Options accepted by `openStage`.

```ts
interface StageOptions {
  /** Semantic stage kind consumed by host progress surfaces. */
  readonly kind?: 'run' | 'session';
  /** Parent handle for nested stages; without one the stage opens as a root. */
  readonly parent?: StageHandle;
}
```

## StepRoot

A read-only directory one step admits for its own calls, beside the
registered roots: a skill it lists or its user activated, canonical as
its catalog entry records it (`canonicalizePath`).

```ts
interface StepRoot {
  readonly absolutePath: string;
  readonly label: string;
}
```

## StreamHandle

Handle returned by `openRun` — append chunks then finalize.

```ts
interface StreamHandle {
  readonly id: string;
  /** Append a chunk of text; emits `stream.chunk`. */
  append(text: string): void;
  /**
   * Close the stream and emit its complete text in `stream.end`. Idempotent.
   * Returns that text to the caller as well.
   */
  finalize(finalText?: string): string;
}
```

## StreamOptions

Options accepted by `openRun`.

```ts
interface StreamOptions {
  /**
   * Defer the `stream.start` emission until the first non-empty chunk (or a
   * finalize that carries text). Subscribers treat `stream.start` as "this
   * phase began" — e.g. thinking streams drive a "model is thinking" liveness
   * indicator — so a stream opened eagerly at request setup must not announce
   * a phase that may never happen. A deferred stream that ends without
   * content emits nothing at all.
   */
  readonly deferStart?: boolean;
}
```

## SubmitFollowUpResult

Three outcomes: the input reached a running loop, it waits in the run's
queue for the next turn, or it was not admitted for a worded reason. A
delivery the admission boundary had already accepted is `sent`. A resume
the input started that the run refused is told by the resume itself; a
queued input whose run could not even be read for a wake is still queued
(`wake: 'failed'`): the input belongs to the run, and an explicit Resume
delivers it.

```ts
type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued'; wake?: 'failed' }
  | { status: 'failed'; reason: FollowUpFailureReason };
```

## TemplateInputs

The fixed variables every prompt template may read.

```ts
type TemplateInputs = typeof TemplateInputsSchema.Type;
```

## TemplateOpening

What a launch opens from: the template inputs; the names of the skills a
tool-use run's instruction activated; the attached memories' XML block,
appended to the system prompt (null when none are attached); and the
attached memories that could not be read.

```ts
interface TemplateOpening {
  readonly inputs: TemplateVars;
  readonly activated: readonly string[];
  readonly attachedMemories: string | null;
  readonly attachedMemoryMisses: AttachedMemoryMiss[];
}
```

## TemplateVars

The template-variable map accepted at the render boundary (PromptBuilder):
fixed variables may be absent (template rendering keeps `throwOnUndefined`
off, so templates must tolerate absence), and a plugin's own variables add
custom keys beside the fixed ones.

```ts
type TemplateVars = Partial<TemplateInputs> & Record<string, unknown>;
```

## ToolAvailabilityChecks

How a plugin with an external dependency answers "is it available": an
optional shared `probe` whose result the availability layer caches and
hands back to `check` (availability), `statusLabel` (dashboard badge) and
`detailCheck` (the line below the description).

```ts
interface ToolAvailabilityChecks<R = ToolProbeServices> {
  /**
   * Optional shared probe result passed to check/status/detail callbacks.
   * Takes the asking workspace as data: a probe may ask whether that folder
   * is a git repository, or read a port out of that workspace's
   * configuration.
   */
  readonly probe?: (
    inputs: ToolProbeInputs,
  ) => Effect.Effect<unknown, ToolProbeError, R>;
  /** Returns true if the external dependency is available. */
  readonly check: (
    probeResult?: unknown,
  ) => Effect.Effect<boolean, ToolProbeError, R>;
  /** Optional detailed status string resolved at check time (shown below description). */
  readonly detailCheck?: (
    probeResult?: unknown,
  ) => Effect.Effect<string | undefined, ToolProbeError, R>;
  /** Optional short status label for the dashboard badge. */
  readonly statusLabel?: (
    probeResult?: unknown,
  ) => Effect.Effect<string | undefined, ToolProbeError, R>;
  /**
   * The secret-store keys this plugin's answer reads. A committed write to any
   * of them (`credentialChanged`) re-probes every open workspace, so a plugin
   * gated on a credential declares it here instead of each host naming it.
   */
  readonly reprobeOnSecrets?: readonly string[];
}
```

## ToolCardHandle

Handle returned by `openToolCard`: one tool call's card, for a caller that
runs the call outside the run loop (an external agent's own tools).

```ts
interface ToolCardHandle {
  /** The log the card last showed. */
  readonly log: ToolUseLog;
  /**
   * Show the call's latest log: an `in_progress` status keeps the card open,
   * any other closes it, and a log without a status closes it as completed.
   */
  update(log: ToolUseLog): void;
  /**
   * Close the card as failed if it is still open, keeping what it last
   * showed: the caller's turn ended before the call reported. A closed card
   * is left as it closed.
   */
  failIfOpen(): void;
}
```

## ToolContext

The tool call the running tool serves.

```ts
class ToolContext extends Context.Service<
  ToolContext,
  ToolContextShape
>()('@texra-ai/harness/agent/ToolContext')
```

## ToolContextShape

What every tool call knows of itself.

```ts
interface ToolContextShape {
  /** The call's id, as the model (or the host) issued it. */
  readonly callId: string;
  /** Where the call works. */
  readonly env: ToolEnv;
  /** Where the call's requests to a person open; absent for a standalone
   *  host invocation outside an agent run, which has nobody to ask. */
  readonly requests?: CallRequests;
  /** Transient output for the call's card while it runs, never a row. */
  readonly emit: (text: string) => void;
}
```

## ToolEditApprovalResult

`appliedContent` is required on acceptance: the proposed file as the user
left it (the decision's `content`), else the proposal itself, so this is a
type-level guarantee rather than a convention callers must null-check.

```ts
type ToolEditApprovalResult =
  | {
      readonly action: 'apply';
      readonly appliedContent: string;
      readonly lineChanges?: {
        readonly added: number;
        readonly removed: number;
      };
      readonly startLine?: number;
    }
  | RefusalDecision;
```

## ToolEditProposal

What a tool proposes; {@link requestToolEditApproval} derives the rest:
the diff a host shows (hunks, the first changed line), computed once, and
the permission every surface lists.

```ts
interface ToolEditProposal {
  readonly path: string;
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly sourceTool: string;
  readonly runId?: RunId | null;
}
```

## ToolEnv

Where a call works: the session's roots (its workspace folder, the
setting slots and its storage), the run's working directory, and the
read-only roots the call's step admits (the skills it lists or its user
activated). A tool's paths resolve against it.
`workingDirectory` is already absolute or absent: the run decides it once
where it is launched (`buildAgentLaunchContext`).

```ts
interface ToolEnv {
  readonly roots: WorkspaceRoots;
  readonly workingDirectory?: string;
  readonly stepRoots?: readonly StepRoot[];
  /** The run the call works for; absent for a standalone host invocation. */
  readonly run?: ToolRun;
}
```

## ToolError

```ts
class ToolError extends Error
```

## ToolFileAttachment

```ts
type ToolFileAttachment = typeof ToolFileAttachmentSchema.Type;
```

## ToolGuard

The guard the run loop applies before a tool's body runs, declared on the
tool instead of called inside it: the paths the call writes and the command
it must get approved. `agent/runtime/loop/toolGuard.ts` is the one place
either is asked for, so no tool body opens its own approval prompt or
re-checks its own roots.

```ts
interface ToolGuard<T, R = never> {
  /**
   * The paths this call writes, read from its arguments. Each is resolved
   * against the call's workspace and working directory — which refuses a path
   * outside either — and refused when it lands in a read-only external root.
   */
  readonly writes?: (input: T) => readonly string[];
  /**
   * The command this call runs, spelled as the approval prompt shows it. The
   * loop puts it through the session's bash approval before the body runs.
   * Only the `bash` tool's commands take the run's command grant; any other
   * tool's call is asked about per call.
   * An Effect because the spelling can depend on settings the prompt must
   * show (a Codex sandbox mode, a Claude permission mode).
   */
  readonly bash?: (input: T) => Effect.Effect<string, Error, R>;
  /**
   * Where the approved command actually runs, when that is not the call's own
   * directory. Omitted: the call's working directory, else the workspace,
   * which is what a shell-shaped tool uses. `'unknown'`: the executor cannot name one, so the
   * prompt names none rather than a directory the command may not run in
   * (`send_to_terminal` reuses a terminal whose shell has its own directory).
   */
  readonly cwd?: 'unknown';
}
```

## ToolPathCall

The call fields a tool path resolves against: the session's roots (its
workspace folder and the setting slots containment policy is read from),
the run's working directory, and the read-only roots the call's step
admits (the skills it lists or its user activated; none outside a run).
A tool's `ToolContext.env` satisfies it structurally.
`workingDirectory` is already absolute or absent: the run decides it once
where it is launched (`buildAgentLaunchContext`).

```ts
interface ToolPathCall {
  readonly roots: { readonly workspace: string | undefined } & SettingsStores;
  readonly workingDirectory?: string;
  readonly stepRoots?: readonly StepRoot[];
}
```

## ToolPathResolution

A resolved tool path plus the POSIX form a tool shows for it.

```ts
interface ToolPathResolution extends WorkspacePathResolution {
  readonly display: string;
}
```

## ToolPolicy

Immutable per-run tool policy, resolved by the launch and read from the
run's `AgentRun` service.

A frozen value the loop takes from context, with no ambient frame anywhere
beneath it — the property an SDK embedder wants.

```ts
interface ToolPolicy {
  /** Stop a tool-use run after one model/tool cycle instead of waiting. */
  readonly stopAfterCycle?: boolean;
}
```

## ToolProbeError

What a plugin's availability callbacks may fail with.

```ts
type ToolProbeError = ToolProbeFailed | SecretsFailed;
```

## ToolProbeFailed

The one failure of this module's probes: the native binary lookup a CLI's
probe runs could not answer. An SDK that will not import is a dashboard
message, not a failure; a localhost request a probe makes folds its own
failures to `false`; and a tool that is simply not installed is
`check` answering `false`.

```ts
class ToolProbeFailed extends Schema.TaggedError<ToolProbeFailed>()(
  'ToolProbeFailed',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
```

## ToolProbeInputs

The asking workspace, carried into a plugin's probe as data rather than read
from an ambient scope: the folder a probe asks whether it is a git
repository, the configuration a probe reads a port from, and the host a
probe asks whether the editor drives a tool for it: three fields of the
roots every caller of the availability surface opened.

```ts
type ToolProbeInputs = Pick<
  WorkspaceRoots,
  'workspace' | 'config' | 'host'
>;
```

## ToolProbeServices

The process services a plugin's availability callbacks read: provider
credentials, the HTTP client a localhost probe requests through, the
spawner every probe runs its child processes on, and the filesystem the
CLI binary probes look in. All four are `ProcessServices` arms, so every
caller of the availability surface already holds them. A plugin's probe
may also read its own process services (`definePlugin`), which it is
served while its layer is up; what its host passes it (an editor's
extensions) it closes over.

```ts
type ToolProbeServices =
  Secrets | FileSystem.FileSystem | HttpClient.HttpClient | ChildProcessSpawner;
```

## ToolRegistry

The process's plugin table, which every run's offered tools come from.

```ts
class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra-ai/harness/tools/ToolRegistry',
)
```

## ToolRun

What a tool reads of the run its call works for, read from the run rather
than copied onto the call. It names the run's id; the runtime adds the
rest.

```ts
interface ToolRun {
  readonly runId: RunId;
}
```

## ToolTable

The process's plugins by plugin id: what each contributes (its tools,
prompt section and layers) is read off its value.

```ts
interface ToolTable {
  /** Every plugin, in the order the app listed them. */
  readonly entries: ReadonlyMap<string, Plugin>;
  /** The tool registered under `name` in any plugin, typed as plugins
   *  declare their tools (`Plugin.tools`). */
  readonly get: (name: string) => ITool<Error, PluginToolServices> | undefined;
  /** Each request kind's decision hook, from the plugin that owns it. */
  readonly decisions: ReadonlyMap<string, RequestDecisionHook>;
  /** The agent-file blocks the plugins own, by key (`Plugin.agentBlock`). */
  readonly blocks: ReadonlyMap<string, AgentBlock>;
}
```

## web

The web: `web_search` and `web_fetch`.

```ts
const web: Plugin
```

## withRequestTimeout

One request under a deadline of `timeoutMs` that spans the whole of
`request` — connection and body read. The attempt's scope stays open
through the body read, so the request (see {@link scopedOkClient}) aborts
when the whole attempt ends. Fails with `Cause.TimeoutError` on the deadline
and otherwise with the request's own failure. Defects and interruption are
not converted into request failures.

```ts
const withRequestTimeout: <T, E, R>(timeoutMs: number, request: Effect<T, E, Scope | R>) => Effect<T, E | TimeoutError, Exclude<R, Scope>>
```

## WorkspacePathResolution

A tool path resolved against the call's roots: its root-relative and
absolute spellings, the path filesystem calls take, and the external root
it falls in, if any.

```ts
interface WorkspacePathResolution {
  readonly relative: string;
  readonly absolute: string;
  /**
   * The path to pass to filesystem operations.
   * Absolute when operating outside the workspace (e.g. a worktree),
   * workspace-relative otherwise.
   */
  readonly fsPath: string;
  /**
   * When the resolved path falls inside a registered external root, this
   * describes that root (label, writable flag). Undefined for workspace paths
   * and for any external path outside the allowlist.
   */
  readonly external?: {
    readonly root: string;
    readonly writable: boolean;
    readonly label: string;
  };
}
```

## WriteFilter

What an app does to the content `write_file` is given before it proposes
it, by path, under the call's workspace configuration (text replacements
for a file type, say). The harness's `write_file` writes what it is given.

```ts
type WriteFilter = (
  path: string,
  content: string,
  config: ConfigProvider,
) => Effect.Effect<string>;
```
