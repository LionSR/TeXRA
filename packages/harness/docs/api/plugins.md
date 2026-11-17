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
  (the `agent` tool, [`AGENT_TOOL_NAME`](#agent_tool_name), and the
  `program` tool), and [`web`](#web) for
  `Sessions.layer({ platform, plugins })`.
- **Plugin & tool authoring**: [`defineTool`](#definetool),
  [`definePlugin`](#defineplugin) and the
  [`Plugin`](#plugin) it returns (what a plugin package declares it exports),
  [`executed`](#executed), [`errorResult`](#errorresult),
  [`ToolError`](#toolerror), [`nullishWithDefault`](#nullishwithdefault),
  [`resolveToolPath`](#resolvetoolpath), and file-edit approval helpers
  ([`requestToolEditApproval`](#requesttooleditapproval),
  [`buildApprovalRejectedResult`](#buildapprovalrejectedresult),
  [`approvedWriteConflict`](#approvedwriteconflict)).
- **Runtime callbacks inside a tool**: the call's run and requests on
  [`ToolContext`](#toolcontext), [`ChildRuns`](#childruns), and
  [`RunInbox`](#runinbox).
- **Lifetimes, prompt sections & durable rows**:
  [`PromptSection`](#promptsection),
  [`ProcessPluginLayer`](#processpluginlayer),
  [`SessionPluginLayer`](#sessionpluginlayer), [`PluginHold`](#pluginhold),
  [`RequestDecisionHook`](#requestdecisionhook) (what commits with the
  decision: [`RequestDecisionRecord`](#requestdecisionrecord)),
  [`FactKind`](#factkind), and [`Program`](#program) (how its run
  reads: [`ProgramResult`](#programresult)).

## AGENT_TOOL_NAME

The tool that runs a named agent as a child of the calling run.

```ts
const AGENT_TOOL_NAME: "agent"
```

## AgentTrace

Agent-general SDK surface. Every method ultimately reduces to `emit()` so
the trace channel is a single source of truth. App-specific helpers are
plain functions over this interface.

```ts
interface AgentTrace {
  // ─── SSoT primitives ────────────────────────────────────────────────
  emit(event: AgentEvent): void;

  // ─── Plain logging (sugar over emit) ────────────────────────────────
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;
  /** A chunk of a process run's output, on its stream (`process.output`). */
  output(stream: 'stdout' | 'stderr', text: string): void;

  // ─── Stages and stream handles ──────────────────────────────────────
  /**
   * Run `use` as a labelled stage (`stage.start`): what it logs on the trace
   * it is handed nests under the stage, which closes once `use` exits
   * (`stage.end`): completed when it succeeds, else as its cause reads
   * (`outcomeFromCause`).
   */
  stage<A, E, R>(
    label: string,
    use: (trace: AgentTrace) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>;
  /**
   * Open a streaming message. Its `stream.start` waits for the first
   * non-empty chunk (or a finalize that carries text): subscribers read
   * `stream.start` as "this phase began" (a thinking stream drives a "model
   * is thinking" indicator), so a stream opened at request setup announces
   * no phase that never happens. A stream that ends without content emits
   * nothing at all.
   */
  openStream(kind: MessageType): StreamHandle;
  /**
   * Open a tool call's card with its first log (`tool.start`). A log whose
   * status is already terminal opens and closes the card at once; one without
   * a status, or `in_progress`, leaves it open for `update`.
   */
  openToolCard(log: ToolUseLog): ToolCardHandle;
}
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

## AppSignals

The process's signal hub: one unbounded `PubSub`, built once by the
process layer and served to every program of the process from context.
Unbounded and never shut down, so publishing never blocks or drops; a
subscription only receives what is published after it exists.

```ts
class AppSignals extends Context.Service<
  AppSignals,
  {
    /**
     * Publish `signal` to every current subscriber and return. Synchronous
     * by construction: the publish is the enqueue, and the hub is unbounded,
     * so it always accepts without suspending. The delivery itself runs on
     * each subscriber's own fiber — see the delivery and error order above.
     * For an owner whose callbacks run outside any fiber (a secret store's
     * commit, a registry's close listener), which captures the service
     * where its layer is built; a program publishes with
     * {@link emitAppSignal}.
     */
    readonly emit: <K extends AppSignal>(
      signal: K,
      payload: AppSignalPayloads[K],
    ) => void;
    /** A subscription to every signal, held for the caller's scope. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<AppSignalEvent>,
      never,
      Scope.Scope
    >;
  }
>()('@texra-ai/harness/AppSignals')
```

## assertNoParentTraversal

Fail when a raw tool path contains a parent-directory segment.

```ts
const assertNoParentTraversal: (targetPath: string) => Effect<void, ToolError, never>
```

## BoundModel

One bound model: llm's `Binding` (or the validation model's) and the facts
of the run the binding serves. Everything else a binding needs (its
credential, its reasoning choice, the toggles it was bound under) stays
inside model access.

```ts
interface BoundModel extends Binding {
  /** The run's model string (`provider/id[@effort][+pro]`), as its rows name it. */
  readonly modelId: string;
  /** The catalog entry the model string names, before any route's overlay:
   *  the id and list prices the usage log reports each call under. */
  readonly catalogEntry: ModelConfig;
  /** The backend its `run.config` records. */
  readonly backend: ModelBackend;
  /** The subscription routes the run had declined when this binding was
   *  decided; its `run.config` records them, and the fold unions them with
   *  every route a retry declines after. */
  readonly declinedRoutes: readonly DeclinableUsageRoute[];
  /** The route decision this binding carries out, or the validation model. */
  readonly route: ModelRoute | { readonly kind: 'validation' };
  /** Automatic retries after a failed attempt, read with the binding. */
  readonly automaticRetries: number;
  /** Bound for a text-only persona, with the model's whole output budget; a
   *  rebinding keeps it. */
  readonly textOnly: boolean;
  /** The ChatGPT plan the subscription's token names; display-only. */
  readonly plan?: string;
  /** The retry gate's routes: the model on its wire route, then the wire route. */
  readonly routes: readonly [RoutePolicy, RoutePolicy];
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

## CallRequests

The requests one tool call raises, opened through its run's loop. Each
carries an id its attempt derives. A request still open when its run
stops is cancelled, and the resumed call asks again under a new id.

```ts
interface CallRequests {
  /** The id the call's next request opens under: the attempt's next
   *  derived id. A request is staged under this id before it opens. */
  readonly nextId: () => string;
  /** Open the request and wait for its decision. The returned payload is
   *  the request as it opened.
   *  `blobs` are the strings the payload names by address, stored with its
   *  row. `operation` is what a command (`bash`) asks permission for: the
   *  shell's (`'bash'`, which the run's command grant answers) or another
   *  tool's call (`'call'`, which only the delegated-work grant answers).
   *  An edit, a plan or a proposal asks about its own kind; with the
   *  call's hooks, the operation decides who answers the request, and a
   *  request about none is a person's. */
  readonly open: <P extends RequestPayload>(
    payload: P,
    opening?: {
      readonly blobs?: readonly DraftBlob[];
      readonly operation?: 'bash' | 'call';
    },
  ) => Effect.Effect<
    {
      readonly payload: Extract<RequestPayload, { kind: P['kind'] }>;
      readonly decision: DecisionOf<P['kind']>;
    },
    DatabaseAggregateClosed | CellError
  >;
  /**
   * Open a plugin's request the call does not wait on, under its
   * `data.requestId`: its `request.opened` commits on the run's history
   * through the one door every request opens at, with `data` stored as
   * the JSON it writes, and the plugin's decision hook takes each answer
   * when it lands (`Plugin.decision`). A person answers it. A failed
   * commit is not proof that nothing landed: the run's rows decide.
   */
  readonly post: (
    request: Omit<PluginRequest, 'blocksCaller' | 'data'> & {
      readonly blocksCaller: false;
      readonly data: Pick<PluginRequest['data'], 'requestId' | 'runId'>;
    },
  ) => Effect.Effect<void, CellError>;
  /** Show the person something on the session's host (a file opened
   *  beside what they are looking at, a notice), answered by nothing. */
  readonly present: <K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ) => Effect.Effect<void>;
}
```

## CellError

What a run cell's commits and re-reads fail with.

```ts
type CellError =
  | RunHistoryRefused
  | DatabaseWriteFailed
  | DatabaseReadFailed;
```

## ChildRunDelivery

A child run's report to its parent ({@link ChildRunDeliverySchema}).

```ts
type ChildRunDelivery = typeof ChildRunDeliverySchema.Type;
```

## ChildRuns

The door, as the run loop provides it beside each call ({@link childRuns}).

```ts
class ChildRuns extends Context.Service<ChildRuns, ChildRunsShape>()(
  '@texra-ai/harness/agent/ChildRuns',
)
```

## ChildRunsShape

A plugin tool's one door to the session's runs. It launches an external
process as a child of its call's run (`launchProcess`: its run id,
outside the child-run budget); a plugin's tool reaches no other launch.
And it reaches a run of the session by id: its input, records, whether
it holds a request, and the plugin's own facts on it, each over the
call's run.

```ts
interface ChildRunsShape {
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
  /** Whether the run holds the request `requestId`, open or decided: what
   *  a tool that posted one reads after a failed post. */
  readonly requested: (
    runId: RunId,
    requestId: string,
  ) => Effect.Effect<boolean, Error>;
}
```

## codemode

Code mode: the `script` tool, a program that calls the run's other tools,
and `self()`, the function a script runs this agent again with. An agent
gets them if its configuration names `script`, or as every run that takes
injected tools does (not a program's run, a text-only persona, or a plugin
agent that names its own tools). A step that offers `script` sends it and
the run's own tools alone; its session layer is the code sandbox the
scripts run in.

```ts
const codemode: Plugin
```

## DecisionOf

The decisions a request of kind `K` takes: its own actions and the three
refusals. A plugin's request declares its actions on its row, so its
type accepts any decision.

```ts
type DecisionOf<K extends RequestPayload['kind']> =
  | Extract<
      RequestDecision,
      {
        action: (typeof OWN_ANSWERS & {
          readonly plugin: PluginRequest['answers'];
        })[K][number];
      }
    >
  | RefusalDecision;
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

## definePlugin

A plugin value from its definition, its own services erased: the
harness's built-ins and an app's plugins are written the same way.

```ts
const definePlugin: <ROut = never>(plugin: PluginDefinition<ROut>) => Plugin
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

## DefineToolOptions

```ts
type DefineToolOptions<T, R = never> = Required<
  Pick<ToolDefinition, 'name' | 'description'>
> &
  Pick<ToolDefinition, 'scriptReturns'> &
  Pick<
    ITool,
    | 'hostCapability'
    | 'lane'
    | 'scriptGlobal'
    | 'replay'
    | 'requiresApproval'
    | 'describe'
  > & {
    /** Decodes the model's input into `T`. */
    schema: Schema.Codec<T, unknown>;
    /**
     * What the run loop checks before this tool's body runs: the paths the
     * call writes and the command it must get approved. Declared here; the
     * loop applies it once, so the body never re-checks it.
     *
     * `NoInfer<R>`: the guard is checked against the requirement channel the
     * tool already has, it never sets it.
     */
    guard?: ToolGuard<T>;
    /** The card a call states from its decoded input (`ToolUseLog.card`).
     *  A call whose input does not decode gets none. */
    card?: (input: T) => ToolCard | undefined;
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

## emitAppSignal

Publish `signal` from a program: {@link AppSignals}' `emit`.

```ts
const emitAppSignal: <K extends AppSignal>(signal: K, payload: AppSignalPayloads[K]) => Effect<void, never, AppSignals>
```

## errorResult

Build a `status: 'error'` result literal. Reserved for call sites that
cannot fail the tool's Effect with a `ToolError` (the usual way, which
`defineTool` turns into the call's error): typically a caller that must keep
running after reporting a partial per-item error. Prefer failing with
`ToolError` whenever the call site can.

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

## FactKind

One row kind a plugin owns (`plugin.fact`): the version it writes and
reads, and the schema of that version's value; a stored row at a lower
version is an earlier build's, and one at a higher version refuses the
store. The store checks every row of the kind against its fact kind, and
reads a row whose fact kind the process's plugins lack (its plugin
removed, or not listed here) as written, marked `unavailable`; a run
holding one does not resume. Fact kinds live beside their readers, in
modules webviews can import.

```ts
interface FactKind {
  /** The plugin's id: a fact kind is its own plugin's, never another's. */
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: Schema.Codec<unknown, unknown>;
  /** What a fork of a run (a conversation's, or a script's `self()` child)
   *  starts with of the run's own row of the kind: `copy` the row the run
   *  held at the cut, `drop` none. A row about the plugin's own aggregate
   *  belongs to that aggregate and stays with it. */
  readonly fork: 'copy' | 'drop';
  /** The kind's own transition rule, checked by its writer in the job that
   *  appends the row (`ownFactsChecked`) against the aggregate's latest row
   *  of the kind (none before the first): the rejection's reason, or null
   *  to accept. */
  readonly accepts?: (
    previous: PluginFactRow | undefined,
    next: PluginFactRow,
  ) => string | null;
  /** Whether the aggregate's `latest` row already says more than `next`
   *  (a call's fact that lagged behind a later writer): the call's batch
   *  then leaves `next` out instead of failing on `accepts`. */
  readonly supersedes?: (latest: PluginFactRow, next: PluginFactRow) => boolean;
  /** The workspace files a row of the kind says its run wrote past the
   *  editor's own write path: every process that folds the run announces
   *  them (`workspaceFilesWritten`), a window hearing a service task's
   *  write as it hears its own. */
  readonly writes?: (value: Schema.Json) => readonly string[];
}
```

## FactKinds

The plugin fact kinds a store reads, by `plugin/kind`.

```ts
type FactKinds = Readonly<Record<FactName, FactKind>>;
```

## fileOps

Files and the shell: every agent needs them. An app passes the filter
`write_file` applies to what it writes (its own content replacements).

```ts
const fileOps: (options?: { readonly writeFilter?: WriteFilter | undefined; }) => Plugin
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

Build the ignore matcher for `workspaceRoot` from its ignore policy files.
The root is the caller's — the `WorkspaceFs` of the session the call works
on — rather than whichever roots the calling fiber carries, so a listing
and the policy that filters it name the same workspace. Read on every call:
a process serves several projects, and each call should see the policy as
it is on disk now.

```ts
const getGitignoreMatcher: (workspaceRoot: string | undefined) => Effect<GitignoreMatcher, PlatformError, FileSystem>
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
in rounds through `self()` (`goalScript`), on the default strategy, its
module `builtIn:goal`, unless `goal.strategy` names another.

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

One message a producer sends: a text, with what surfaces show instead
(`displayText`) and a user's media (e.g. pasted images) with its blobs
(`attachedMedia`); or a child's delivery to its parent, whose facts its
row keeps typed.

```ts
type InboxItem = (
  | {
      readonly text: string;
      readonly displayText?: string;
      readonly media?: readonly StoredMedia[];
      readonly blobs?: readonly DraftBlob[];
    }
  | { readonly delivery: ChildRunDelivery }
) & {
  readonly from: FollowUpSender;
  /** Identity of a delivery its producer may repeat (a child's result):
   *  the row's `followUpId`, so a replay writes nothing. */
  readonly deliveryId?: string;
  /** A request of the run's own (`/compact`, a model switch), not a message. */
  readonly control?: QueuedFollowUp['control'];
};
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
   *   every call after it until it finishes.
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
   * `'safe'`.
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
  /** The loop-side guard this tool declares; see {@link ToolGuard}. */
  readonly guard?: ToolGuard<never>;
  /**
   * A description rendered from the other tools the run declares, the
   * modules its scripts may import and the programs they may start, in
   * place of `definition.description`:
   * rendered at the step that freezes the run's system text and kept as
   * that step recorded it until a compaction opens the freeze again, so a
   * catalog change mid-run leaves its text, and the cached
   * prefix through it, as it was. The tool that has one is the script tool,
   * which reaches nothing but the run's other tools and its own agent: a
   * child is offered it, and its script-only functions, whatever its parent
   * was.
   */
  readonly describe?: (
    declared: readonly Pick<ITool, 'definition' | 'scriptGlobal'>[],
    /** The specifiers of the modules the step's scripts may import. */
    modules: readonly string[],
    /** The programs of the step's plugins, each with its one-line
     *  description. */
    programs: readonly {
      readonly name: string;
      readonly description: string;
    }[],
  ) => string;
  call(rawInput: unknown): Effect.Effect<ToolResult, E, R>;
}
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
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, JsonRpcRequestError | JsonRpcConnectionDisposed>;
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
  /** The notification telling the peer we stopped waiting for unanswered
   *  request `id` (its caller was interrupted, a timeout too). */
  cancel?(
    id: number,
    method: string,
  ): { readonly method: string; readonly params: unknown } | undefined;
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

What a trace's log methods take: a row's category (subscribers pick a
render style from it) with the payload the transcript decodes for it,
so a pairing is checked where it is written; or no category, a default
row with any data. The row stores the payload as JSON; a `Cause` stores
as the error it raised.

```ts
type LogOptions =
  | { readonly messageType?: undefined; readonly data?: unknown }
  | {
      // A payload is required unless the type's schema accepts none.
      [
        K in MessageType
      ]: undefined extends (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded']
        ? {
            readonly messageType: K;
            readonly data?: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded'];
          }
        : {
            readonly messageType: K;
            readonly data: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded'];
          };
    }[MessageType];
```

## makeJsonRpcConnection

```ts
const makeJsonRpcConnection: (options: JsonRpcConnectionOptions) => Effect<JsonRpcConnection, never, Scope>
```

## MemoryPinResult

What a pin did: `cap-reached` names the cap it hit.

```ts
type MemoryPinResult =
  | { readonly status: 'pinned'; readonly pinnedCount: number }
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
const MemoryStore: { folder: "memories"; storagePath: (input: string) => Effect<string, Error, never>; displayPath: (storagePath: string) => string; list: Effect<{ readonly displayPath: string; readonly storagePath: string; readonly size: number; readonly mtime: string; readonly preview?: string | undefined; readonly lineCount?: number | undefined; readonly previewError?: boolean | undefined; readonly modifiedBy?: string | undefined; readonly pinned?: boolean | undefined; }[], PlatformError, StorageFs>; preview: (input: string) => Effect<MemoryPreview, Error | PlatformError, StorageFs>; delete: (input: string) => Effect<void, Error | PlatformError, StorageFs>; pin: (input: string) => Effect<MemoryPinResult, Error | PlatformError, StorageFs>; unpin: (input: string) => Effect<void, Error | PlatformError, StorageFs>; }
```

## memoryWorkflow

Memory and past runs: the `memory` tool, offered while memory is on,
and `executions`.

```ts
const memoryWorkflow: Plugin
```

## ModelRetryGate

Gate `attempt` on every route in `routes`, narrowest first. The tuple is
non-empty because an empty list would run the attempt ungated.

```ts
interface ModelRetryGate {
  readonly withRoutes: (
    routes: readonly [RoutePolicy, ...RoutePolicy[]],
  ) => <A, E, R>(attempt: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
```

## multiAgent

Child runs: the `agent` tool, and `program` for a registered program.

```ts
const multiAgent: Plugin
```

## noLaterTurn

Whether no later turn reaches `run`: a root that stops after its cycle,
or a child its parent's call awaits (the call reads its end and goes
on). A background child stops after its cycle too, but a delivery or a
message resumes it, so a result sent to it as a follow-up arrives.

```ts
const noLaterTurn: (run: Pick<ToolRun, "toolPolicy" | "entry">) => boolean
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

## PlatformSecrets

Provider for secure secret storage (API keys, tokens).

Every member is an `Effect`, so a caller inside a program gets
the failure typed as {@link SecretsFailed} instead of `unknown`, and a
credential read is interruptible like the program around it.
{@link PlatformSecrets.set} and {@link PlatformSecrets.delete}
carry one extra rule: a credential
commit survives cancellation. The uninterruptible region is the commit
itself and nothing before it — for the file-backed store it begins once
the write lane has been entered, inside `FileSecrets`, so a write still
queued behind another one can be cancelled. Everything that
prepares a write — the lane wait, opening the store — stays interruptible, because interruption there means
nothing was written. A post-commit step cannot run as a step after the
write: a commit the store landed still exits as interrupted when its caller
was cancelled during it, so the step would be skipped over a credential
that is now on disk. The host stores therefore own the post-commit facts
themselves, in an `Effect.ensuring` finalizer that runs on every exit: the
file store tells the `credentialChanged` app signal its layer hands it
(`Secrets.announcing`). A writer does not by hand.

```ts
interface PlatformSecrets extends CredentialStore {
  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed>;
}
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
  /** Its tools, registered by each tool's `definition.name`, in order. */
  readonly tools?: readonly ITool<Error, PluginToolServices>[];
  /**
   * Present when the plugin has an external dependency: it is probed, and
   * its tools are withheld while the dependency is missing. Without it the
   * plugin is built in and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  /** The plugin has a user switch, which a fresh install sets to this
   *  position; while off, its tools are withheld from every agent. A
   *  switched plugin with no `availability` is probed as needing nothing.
   *  Without a switch the plugin is always on. */
  readonly toggle?: 'on' | 'off';
  /** Tools of this plugin offered to every agent with tools, declared or not,
   *  while the plugin is on and a boolean catalog setting is on: tool name to
   *  setting row, or `true` for no setting but the plugin's own switch. An
   *  injected tool still passes the host and approval gates; a script's
   *  run (a program) and a text-only persona get none. */
  readonly injectedWhen?: Readonly<Record<string, SettingRow<boolean> | true>>;
  /** Its section of each request's system text, pinned while it is on. */
  readonly prompt?: PromptSection;
  /** Process-lifetime services, up while the plugin is switched on or a step
   *  pins it. A host-supplied one (VS Code's setup commands) is passed with
   *  the host's plugin value. */
  readonly processLayer?: ProcessPluginLayer;
  /** Session-lifetime services, one per open session, up while the plugin
   *  is switched on or a step of that session pins it. */
  readonly sessionLayer?: SessionPluginLayer;
  /** Its side of a decision on a pending request it opened, on or off. */
  readonly decision?: RequestDecisionHook;
  /** The row kinds it owns (`plugin.fact`), on or off: rows outlive it. */
  readonly factKinds?: readonly FactKind[];
  /** Script module sources by name, imported as `builtIn:<name>`. */
  readonly scriptModules?: Readonly<Record<string, string>>;
  /** Those of its `scriptModules` a person or a model starts by name
   *  (`Program`), each under its module's name. */
  readonly programs?: Readonly<Record<string, Program>>;
  /** The plugins it runs on, by id; a list lacking one is rejected. */
  readonly requires?: readonly string[];
}
```

## PluginDefinition

A plugin as its author writes it: its tools, layers and probe may
require `ROut`, the services its own layers serve, beside the harness's.
`definePlugin` checks that at compile time (a tool that needs a service no
layer of its plugin serves does not compile) and erases it: the table
holds every plugin alike, and the step that pins a plugin provides its
layers' services to its calls.

```ts
interface PluginDefinition<ROut> extends Omit<
  Plugin,
  'tools' | 'processLayer' | 'sessionLayer' | 'availability'
> {
  readonly tools?: readonly ITool<Error, PluginToolServices | ROut>[];
  readonly processLayer?: ProcessPluginLayer<ROut>;
  readonly sessionLayer?: Layer.Layer<ROut, never, PluginHold>;
  /** Probed outside any step, whether or not the plugin is on: it may
   *  require only the process's probe services. Its own process services
   *  are offered while its layer is up, read with `Effect.serviceOption`. */
  readonly availability?: ToolAvailabilityChecks;
}
```

## PluginFactRow

One stored row of a plugin's kind, as its fact kind's transition rule reads
it: the row's decoded value and the run it is parented to, if any.

```ts
interface PluginFactRow {
  readonly value: Schema.Json;
  readonly parent: RunId | null;
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
to, and the process's filesystem, paths, child processes, application
state (a language server pool spawns and reads its settings) and signal
hub (the GitHub subscriptions announce their bindings).

```ts
type PluginLayerServices =
  | ToolCatalog
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | AppState
  | AppSignals;
```

## PluginToolServices

The services the runtime supplies to a tool's call, a plugin's and a
built-in's alike: the process's, the rooted filesystems of the session
the call works in, the call (`ToolContext`, the run included) and its
child-launch door (`ChildRuns`). A tool takes `WorkspaceFs` from context
instead of resolving a static against whichever roots its fiber happens
to carry. A plugin's tool reads the door and never the session's own
services or the call's place in its run (`RunCall`), which only the
harness's built-ins reach (`inRunSession`).

```ts
type PluginToolServices =
  | RunServices
  | ToolContext
  | ChildRuns
  | WorkspaceFs
  | StorageFs
  | Scope.Scope;
```

## ProcessChildLaunch

A process child as the tool launching it describes it: how it reads
(`identity`), its record, its task label, and the turn built around the
trace of the run the launch registered.

```ts
interface ProcessChildLaunch {
  readonly identity: Extract<RunIdentity, { kind: 'agent' | 'process' }>;
  readonly config: RunRecord;
  readonly description: string;
  /** The turn, built around the trace of the run the launch registered. */
  readonly turn: (ctx: {
    readonly logger: AgentTrace;
    readonly runId: RunId;
  }) => ProcessTurn;
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

## ProcessReport

What one process turn reports as it returns.

```ts
interface ProcessReport {
  /** The delivery its parent reads, typed. */
  readonly report: ChildRunDelivery;
  /** How a command exited, recorded as the run's `process.exit` row: a
   *  code other than 0 ends the run failed, its report still delivered. */
  readonly exit?: ProcessExit;
  /** A failure a process with no exit of its own reported without
   *  throwing (an SDK's error result): the run ends failed with it, its
   *  report still delivered. */
  readonly failure?: string;
}
```

## ProcessTurn

A process child's one turn, built around the run's trace.

```ts
interface ProcessTurn {
  /** The turn: the whole process, its output on the trace, over the
   *  process's services (a spawner, the filesystem). A stop interrupts it:
   *  a foreign call takes its signal from that interruption
   *  (`Effect.abortSignal`). */
  readonly run: Effect.Effect<ProcessReport, Error, PlatformServices>;
  /** The delivery of a turn that threw. */
  readonly reportError: (error: Error) => ChildRunDelivery;
}
```

## Program

One of a plugin's script modules that a person or a model starts by name
(`Plugin.programs`): the module's default export is
`async (args) => result`, and a run opened on it
(`AgentConfig.script` of kind `program`) is a script run that imports the
module and calls that export with the launch's `args`. The plugin wrote
it, not a model, so the launch that chose it granted it: its tools are
the listed ones past any switch, its `agent` calls run under the launch's
approval, and its prompts and files pass as written.

```ts
interface Program<R = unknown> {
  /** One line: what the program does and the `args` it reads. The script
   *  tool's description lists it. */
  readonly description: string;
  /** The tools its run is offered, by name. */
  readonly tools: readonly string[];
  /** How a completed run of it reads to whoever launched it. Without one,
   *  the run delivers its reply alone. */
  readonly result?: ProgramResult<R>;
  /** The files its run writes when its launch names none, for a program
   *  that creates documents (a deck, a transcript) and does not rewrite
   *  its inputs. */
  readonly outputs?: readonly string[];
  /** The `args` keys whose string values name a file the program reads. A
   *  launch a model asks for resolves each as it resolves the launch's
   *  file lists: a run-storage file must be the caller's own or a declared
   *  output of a completed child of it. */
  readonly fileArgs?: readonly string[];
}
```

## ProgramChange

One file a program wrote, as a script summary counts it.

```ts
interface ProgramChange {
  /** The workspace path the file replaces. */
  readonly path: string;
  /** The file the program wrote. */
  readonly absolutePath: string;
  /** The file it was diffed against, when it continues one: an earlier
   *  call's `absolutePath` continues that call's row. */
  readonly base: string | null;
  readonly added: number | null;
  readonly removed: number | null;
}
```

## ProgramResult

How a completed program run reads: to the launching model, and to a
script's summary of the files its calls wrote. What it reports is the
run's latest row of the plugin's own `fact` kind (`Plugin.factKinds`),
the one record of it; the program's return value is not read. The harness
reads the row only through these.

```ts
interface ProgramResult<R = unknown> {
  /** The plugin's row kind that records what the run did, and the schema
   *  its value decodes with. A completed run with no such row, or one that
   *  fails the schema, is delivered as an invalid result naming the issue,
   *  never shaped. */
  readonly fact: {
    readonly plugin: string;
    readonly kind: string;
    readonly schema: Schema.Codec<R, unknown>;
  };
  /** The delivery body inside the harness's own result envelope. */
  delivery(value: R, runId: RunId): readonly string[];
  /** The files the program wrote, in the order it wrote them (a document
   *  revised twice appears twice, the later entry its latest): the files a
   *  parent may read of its child's storage, and a script's summary. */
  changes(
    value: R,
    roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  ): readonly ProgramChange[];
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
  /** The run's workspace configuration, for a section that follows a
   *  setting of its plugin's. */
  readonly config: ConfigProvider;
}) => string;
```

## randomizedExponentialBackoff

```ts
function randomizedExponentialBackoff(base: Duration.Input)
```

## RefusalDecision

The arms that decline a request, whatever the provenance.

```ts
type RefusalDecision = Extract<
  RequestDecision,
  { action: 'reject' | 'deny' | 'cancel' }
>;
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

A plugin's side of a decision on a pending request it opened (a
`PluginRequest` naming it), run before the decision commits: what the
plugin records outside the session's store, and what commits with the
decision in its one checked transaction ({@link RequestDecisionRecord}).
The outside record must be idempotent: an answer tried again after a
failure, or raced by another, records nothing twice, and the second
reads the first's. A process that exits before the transaction leaves
the request pending and answerable.

```ts
interface RequestDecisionHook {
  readonly record: (request: {
    readonly payload: PluginRequest;
    readonly decision: RequestDecision;
  }) => Effect.Effect<RequestDecisionRecord, Error, GlobalValues>;
}
```

## RequestDecisionRecord

What commits with a plugin request's decision, in its transaction
({@link RequestDecisionHook}).

```ts
interface RequestDecisionRecord {
  /** Facts about the plugin's own aggregates, hung under the request's run
   *  and checked in the transaction: one its kind refuses is logged and
   *  left out. */
  readonly facts: readonly (ToolFact & { readonly aggregate: string })[];
  /** The input the plugin sends a run of the session, accepted in the
   *  transaction (one the run's closed input refuses is logged), the run
   *  woken for it once that commits. */
  readonly followUp?: { readonly runId: RunId; readonly item: InboxItem };
}
```

## requestToolEditApproval

Ask the person for an edit when the session's policy, given what the
call's hooks said, asks: a `request.opened` on the run
that names the proposal's content (the original and proposed text with
their diff) by its address in the session's blob store, stored with the
row, so every process the request reaches shows the same diff
(`request.preview`); answered by a surface's `request.decide`, or by the
edit grant turned on meanwhile. An approve applies the file as the
person left it: the decision's content, else the proposal.

```ts
const requestToolEditApproval: (request: ToolEditProposal) => Effect<ToolEditApprovalResult, Error, ToolContext>
```

## resolveToolPath

Resolve a tool path, relative or absolute, against the call's working
directory when the run has one and its workspace folder otherwise.

A path that escapes that root is accepted only inside a registered external
root or with path protection switched off; otherwise it fails with a
`ToolError` the tool runner reports to the model. With no folder open and
no working directory, only an absolute path can resolve (the agent
directories are registered external roots).

`fsPath` is workspace-relative for a workspace path, so the confined
`WorkspaceFs` view answers it, and absolute for a working-directory or
outside path.

```ts
const resolveToolPath: (call: ToolPathCall, targetPath?: string | undefined) => Effect<ToolPathResolution, Error, never>
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

## RoutePolicy

One route a binding's calls go through: its key, and the scope of the
failures that cool it (llm's `ModelError.scope`).

```ts
interface RoutePolicy {
  readonly key: string;
  readonly scope: 'model' | 'route';
}
```

## runDirUnder

A run's directory under `storageRoot`.

```ts
function runDirUnder(storageRoot: string, id: RunId): string
```

## runEntryUnder

Inspect one run-relative entry of run `runId`'s storage under
`storageRoot` without following a workspace-mirror symlink, the entry's
own or an ancestor directory's.

```ts
const runEntryUnder: (storageRoot: string, runId: string & Brand<"RunId">, relativePath: string) => Effect<{ readonly kind: "file"; readonly location: { readonly kind: "runStorage"; readonly absolutePath: string; readonly relativePath: string; readonly runId: string & Brand<"RunId">; }; } | { readonly kind: "symlink" | "directory" | "unsupported"; readonly absolutePath: string; } | { readonly kind: "missing"; } | { kind: "invalid"; reason: string; }, PlatformError, FileSystem>
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
this type: reporting a disk error as a refused run is the silent-
degradation defect in a different costume, so `open` and `load` keep
them in their error channel beside it.

Which arms are reachable, and from where:
- `not-owner`: from `RunCell.append`, where the session's log refuses a
  closed target as `DatabaseAggregateClosed`, nothing written. It is never
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
- `foreign-protocol`: from a resume's activation, before its rows: a turn
  the history replays was recorded on another protocol than the run's
  binding speaks now, so no request could replay it.
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
      'foreign-protocol',
    ]),
    runId: RunIdSchema,
    detail: Schema.String,
    cause: Schema.optional(RunHistoryInconsistent),
  },
)
```

## RunInbox

One run's input, as a plugin reaches it: what it sends the run (routed,
accepted and woken as {@link submitFollowUp} does), and when the run
takes no more.

```ts
interface RunInbox {
  /** Deliver `item` to the run. */
  readonly send: (
    item: InboxItem,
  ) => Effect.Effect<SubmitFollowUpResult, Error>;
  /** Hear the run take no more input, or its session's inbox close;
   *  returns the detach. */
  readonly onClosed: (listener: () => void) => () => void;
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

## Secrets

The process's secret store as an Effect service, provided once by the composition root through
`processLayer`. The shape is the port itself: a program that reads
or writes a credential yields the store's own Effect and matches
{@link SecretsFailed}.

Both layers also serve the store's `SubscriptionAccounts`, built with it:
a program that reads a subscription session reads it from the store in
force, and a layer that provides another store provides its accounts.

`layer` takes a store built before the runtime (an embedder's, a test's):
the service is that value, not a thunk resolved per member call.

```ts
class Secrets extends Context.Service<Secrets, PlatformSecrets>()(
  '@texra-ai/harness/platform/Secrets',
)
```

## SESSION_CLOSE_DEADLINE_MS

The budget one session close spends waiting for its runs to end before it
reports the ones still live abandoned (`SessionOwner.close`). A hung run
must not wedge desktop quit, eat the extension's ~5s deactivate budget, or
stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
together, so they finish under one deadline for the process, not one each.

```ts
const SESSION_CLOSE_DEADLINE_MS: 5000
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

## Settings

Every read and write of a setting; see the module comment.

```ts
const Settings: Readonly<{ readonly get: <A>(stores: SettingsStores, row: SettingRow<A>) => Effect<A, StateReadFailed, never>; readonly inspect: <A>(stores: SettingsStores, row: SettingRow<A>) => Effect<StoredSetting<A>, StateReadFailed, never>; readonly getConfig: <A>(config: ConfigProvider, row: SettingRow<A>) => A; readonly defaultOf: <A>(catalog: SettingsCatalog, row: SettingRow<A>) => A; readonly set: <A>(stores: SettingsStores, row: SettingRow<A>, value: A, target?: ConfigTarget | undefined) => Effect<void, Error | ConfigWriteFailed, never>; readonly reset: (stores: SettingsStores, row: SettingRow<unknown>, target?: ConfigTarget | undefined) => Effect<void, Error | ConfigWriteFailed, never>; readonly state: <A>(store: Pick<StateStore, "get">, key: StateKey<A>) => Effect<A, StateReadFailed, never>; }>
```

## SettingsStores

The setting slots a caller holds: a `WorkspaceRoots` is one.

```ts
interface SettingsStores {
  readonly config: ConfigProvider;
  readonly workspaceState: StateStore;
  readonly repoState: StateStore;
  readonly globalState: StateStore;
}
```

## sourceLocationUnder

Where a path a run reads from lives, under the roots its caller holds: a
file in run storage keeps its run's provenance, anything else is its
workspace or external location.

```ts
function sourceLocationUnder(
  roots: { readonly storage: string; readonly workspace: string | undefined },
  inputPath: string,
): FileLocation
```

## StepRoot

A read-only directory one step accepts for its own calls, beside the
registered roots: a skill it lists or its user activated, canonical as
its catalog entry records it (`canonicalizePath`).

```ts
interface StepRoot {
  readonly absolutePath: string;
  readonly label: string;
}
```

## StorageFs

The session's own storage root (under the process's storage directory).

```ts
class StorageFs extends Context.Service<StorageFs, RootedFileSystem>()(
  '@texra-ai/harness/platform/StorageFs',
)
```

## StreamHandle

Handle returned by `openStream` — append chunks then finalize.

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

## SubmitFollowUpResult

Three outcomes: the input reached a running loop, it waits in the run's
queue for its next turn (the resume the send started, or an explicit
one), or it was not accepted, with the words that say why. A delivery the
acceptance boundary had already accepted is `sent`. A resume the input
started that the run refused is told by the resume itself.

```ts
type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued' }
  | { status: 'failed'; message: string };
```

## ToolAvailabilityChecks

How a plugin with an external dependency answers "is it available": one
check returns availability and its dashboard explanation from the same
observations. The availability layer owns caching, refresh and deadlines.

```ts
interface ToolAvailabilityChecks<R = ToolProbeServices> {
  /**
   * Check the asking workspace and return its availability with an optional
   * short badge and explanation. A failed optional detail belongs here:
   * log its cause and retain the availability already established.
   */
  readonly check: (inputs: ToolProbeInputs) => Effect.Effect<
    {
      readonly available: boolean;
      readonly statusLabel?: string;
      readonly statusDetail?: string;
    },
    ToolProbeError,
    R
  >;
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
  /** Where the call's requests to a person open. */
  readonly requests: CallRequests;
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
      /** The reviewed base, used to reconcile changes made while waiting. */
      readonly originalContent: string | null;
      /** The reviewed proposal, before any edits made in the approval view. */
      readonly proposedContent: string;
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
  /** Null when the file did not exist when this edit was proposed. */
  readonly originalContent: string | null;
  readonly proposedContent: string;
  readonly sourceTool: string;
}
```

## ToolEnv

Where a call works: the session's roots (its workspace folder, the
setting slots and its storage), the run's working directory, and the
read-only roots the call's step accepts (the skills it lists or its user
activated). A tool's paths resolve against it.
`workingDirectory` is already absolute or absent: the run decides it once
where it is launched (`buildAgentLaunchContext`).

```ts
interface ToolEnv {
  readonly roots: WorkspaceRoots;
  readonly workingDirectory?: string;
  readonly stepRoots?: readonly StepRoot[];
  /** The run the call works for. */
  readonly run: ToolRun;
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
it must get approved. The run loop is the one place either is checked,
so no tool body re-checks its own roots or asks for the
command's approval; a tool whose body asks its own question declares
`requiresApproval: 'inBody'` (below).

```ts
interface ToolGuard<T> {
  /**
   * The paths this call writes, read from its arguments. Each is resolved
   * against the call's workspace and working directory — which refuses a path
   * outside either — and refused when it lands in a read-only external root.
   */
  readonly writes?: (input: T) => readonly string[];
  /**
   * The command this call runs. Present: the loop puts it through the
   * session's command approval before the body runs.
   */
  readonly command?: {
    /** The command as the approval prompt shows it. */
    readonly text: (input: T) => string;
    /**
     * The standing grant that answers this tool's commands. `'bash'`: the
     * run's command grant ("approve all commands in this task"), which the
     * shell declares. Omitted: each call is asked about and only the
     * delegated-work grant covers it, so a tool whose prompt looks like a
     * command (an MCP tool, codex) never inherits shell permission.
     */
    readonly grant?: 'bash';
    /**
     * Where the approved command actually runs, when that is not the call's
     * own directory. Omitted: the call's working directory, else the
     * workspace, which is what a shell-shaped tool uses. `'unknown'`: the
     * executor cannot name one, so the prompt names none rather than a
     * directory the command may not run in (`send_to_terminal` reuses a
     * terminal whose shell has its own directory).
     */
    readonly cwd?: 'unknown';
  };
}
```

## ToolPathCall

The call fields a tool path resolves against: the session's roots (its
workspace folder and the setting slots containment policy is read from),
the run's working directory, and the read-only roots the call's step
accepts (the skills it lists or its user activated; none outside a run).
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

A readonly value the loop takes from context, with no ambient frame
anywhere beneath it — the property an SDK embedder wants.

```ts
interface ToolPolicy {
  /** Stop a tool-use run after one model/tool cycle instead of waiting.
   *  Whether a later turn can still reach the run is read off this and the
   *  launch's parent edge. */
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
repository and the configuration a probe reads a port from: two fields of
the roots every caller of the availability surface opened.

```ts
type ToolProbeInputs = Pick<WorkspaceRoots, 'workspace' | 'config'>;
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
  | Secrets
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ChildProcessSpawner;
```

## ToolRegistry

The process's plugin table, which every run's offered tools come from.

```ts
class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra-ai/harness/tools/ToolRegistry',
)
```

## ToolResult

```ts
type ToolResult = typeof ToolResultSchema.Type;
```

## ToolRun

What a tool reads of the run its call works for, read from the run rather
than copied onto the call: exactly the fields the app's tools read. Its
id, policy, configuration (which holds its delegation scope), model,
scope (a tool that starts something the run should stop registers that
stop there) and trace (what a plugin's own stages nest under). Never its
session: a plugin reaches the session's runs through `ChildRuns`, and
shows the person something through its call's `requests.present`.
What only the harness's built-in tools read stays internal.

```ts
interface ToolRun {
  readonly runId: RunId;
  readonly toolPolicy: ToolPolicy;
  /** The parent this activation runs under (null for a root), and
   *  whether the parent's call awaits it: with the policy, what
   *  `noLaterTurn` reads. */
  readonly entry: {
    readonly parent: RunId | null;
    readonly awaited: boolean;
  };
  readonly config: AgentConfig;
  readonly model: ScopedRef.ScopedRef<BoundModel>;
  readonly scope: Scope.Scope;
  readonly logger: AgentTrace;
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
  /** The programs the plugins register, by name (`Plugin.programs`). */
  readonly programs: ReadonlyMap<string, Program>;
  /** The row kinds the plugins own, by `plugin/kind` (`Plugin.factKinds`):
   *  what a store opened in this process reads. */
  readonly factKinds: FactKinds;
}
```

## web

The web: `web_search` and `web_fetch`.

```ts
const web: Plugin
```

## withLogChannel

Name the channel every `Effect.log*` inside `self` belongs to. Annotations
nest, so a callee that names its own channel keeps it: this sets the channel
for the entries that don't.

```ts
const withLogChannel: (channel: string) => <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
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

## WorkspaceFs

The workspace folder the session works on.

```ts
class WorkspaceFs extends Context.Service<
  WorkspaceFs,
  RootedFileSystem
>()('@texra-ai/harness/platform/WorkspaceFs')
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
