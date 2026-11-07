# `@texra-ai/harness/schemas`

<!-- Generated from `packages/harness/src/schemas.ts` by `npm run docgen`; do not edit. -->

Browser-safe Effect Schemas, derived types, and pure read helpers for
`@texra-ai/harness`.

> **Guide:** Read [Views, Transcripts & Renderers](/api/views-and-transcripts)
> and [Durable Protocol & Recovery](/api/durable-protocol) for how views,
> runtime requests, and approval policies work.

- **Session & run views**: [`SessionView`](#sessionview), [`RunView`](#runview),
  [`TranscriptView`](#transcriptview), [`PendingRequest`](#pendingrequest),
  and pure queries ([`acceptsFollowUp`](#acceptsfollowup),
  [`attentionOf`](#attentionof), [`sessionActivity`](#sessionactivity),
  [`descendantRuns`](#descendantruns), [`runActionRefusal`](#runactionrefusal)).
- **Commands & approvals**: [`RuntimeRequestSchema`](#runtimerequestschema)
  ([`RuntimeRequest`](#runtimerequest)), [`RequestDecision`](#requestdecision),
  [`OutcomeSchema`](#outcomeschema), [`RequestErrorSchema`](#requesterrorschema),
  [`ApprovalPolicySchema`](#approvalpolicyschema), [`resolveBypass`](#resolvebypass).
- **Agent definitions & run outcomes**: [`AgentConfigSchema`](#agentconfigschema),
  [`InlinePersonaSchema`](#inlinepersonaschema), [`RunEndSchema`](#runendschema),
  [`RunIdSchema`](#runidschema), [`StartRequestSchema`](#startrequestschema).
- **Settings & trace export**: [`settingsCatalog`](#settingscatalog),
  [`configTreeRows`](#configtreerows), [`GlobalStateKey`](#globalstatekey),
  [`WorkspaceStateKey`](#workspacestatekey), [`TraceDocumentSchema`](#tracedocumentschema).

## acceptsFollowUp

Whether a run takes a follow-up at all, the one rule every host reads (it
decides whether the composer shows). A run launched taking none
(`takesFollowUps`) and a run whose rows this build cannot read take none;
a run still going or waiting takes one, as does a stopped root agent with
saved steps, which a resume continues from its history.

```ts
function acceptsFollowUp(run: ReadRunView): boolean
```

## ActiveSkillSourceScope

```ts
type ActiveSkillSourceScope =
  (typeof ActiveSkillSourceScopeSchema)['Type'];
```

## ActiveSkillSourceScopeSchema

Canonical skill-source scope vocabulary, shared with the skills loader
and the persisted disabled-source setting, so
a scope added here is representable everywhere.

```ts
const ActiveSkillSourceScopeSchema: Literals<readonly ["bundled", "user", "project", "interop", "custom"]>
```

## AGENT_SKILLS_CONFIG_KEY

```ts
const AGENT_SKILLS_CONFIG_KEY: "skills.enabled"
```

## AGENT_SOURCE

```ts
const AGENT_SOURCE: { readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }
```

## AgentConfig

```ts
type AgentConfig = typeof AgentConfigSchema.Type;
```

## AgentConfigInput

```ts
type AgentConfigInput = typeof AgentConfigObjectSchema.Encoded;
```

## AgentConfigPayload

Partial agent configuration accepted before launch-time normalization.

```ts
type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'agent' | 'model'>;
```

## AgentConfigSchema

Canonical configuration: at most as many outputs as text/media inputs, and
a persona exactly when the agent is inline, named as the agent is.

```ts
const AgentConfigSchema: Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>
```

## agentFileName

The agent name in an identifier as one file-name segment: a plugin
agent's `<plugin>:<name>` becomes `<plugin>__<name>`, since `:` is not a
file-name character on every platform. Run packs, run directories and
copy stems derive their names through this alone.

```ts
function agentFileName(key: string): string
```

## agentKey

Canonical key format: disambiguates agents with same name across sources.

```ts
function agentKey(source: string, name: string): string
```

## agentKeyOf

Canonical key for an agent-like record. Single source for the "entry → key"
mapping so the dozen-plus call sites don't each spell out
`agentKey(x.source, x.name)`.

```ts
function agentKeyOf(entry: { source: string; name: string }): string
```

## agentMatchesIdentifier

Match bare names by name and source-qualified keys by exact identity.

```ts
function agentMatchesIdentifier(
  entry: { source: string; name: string },
  identifier: string,
): boolean
```

## agentName

The agent name in an identifier: a source-qualified key's name
("plugin:paper:review" → "paper:review", "custom:x" → "x"), or the
identifier itself when it names no source ("paper:review", or a URL).

```ts
function agentName(key: string): string
```

## AgentNotFoundPayload

The agent a launch named is not in the catalog.

```ts
interface AgentNotFoundPayload {
  agentName: string;
}
```

## AgentProposal

```ts
type AgentProposal = typeof AgentProposalSchema.Type;
```

## AgentProposalPermission

```ts
type AgentProposalPermission =
  (typeof AgentProposalPermissionSchema)['Type'];
```

## AgentRunListingEntry

A run a person started, as a history list shows it.

```ts
type AgentRunListingEntry = typeof AgentRunListingEntrySchema.Type;
```

## AgentRunListingEntrySchema

A run a person started themselves, as a history list shows it: an agent
run with no parent, with its record. Background processes and scripts
(`identity.kind`) and the runs an agent spawned, which belong to their
parent's transcript, are not listed; a lookup by explicit id reads the
run's records instead.

```ts
const AgentRunListingEntrySchema: Struct<{ readonly id: brand<String, "RunId">; readonly timestamp: String; readonly outcome: NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>; readonly description: optional<String>; readonly model: optional<String>; readonly resumable: Boolean; readonly resumeBlocked: optional<String>; readonly identity: Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>; readonly record: Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>; }>
```

## AgentScanIssue

```ts
type AgentScanIssue = typeof AgentScanIssueSchema.Type;
```

## AgentScanIssueSchema

A custom-agent YAML file the registry found but could not load.

```ts
const AgentScanIssueSchema: Struct<{ readonly path: String; readonly message: String; }>
```

## AgentSource

```ts
type AgentSource = typeof AgentSourceSchema.Type;
```

## AgentSourceSchema

Single source of truth for agent source identifiers.

```ts
const AgentSourceSchema: Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>
```

## AggregateKind

The kind separates lifecycles even when their logical ids coincide:
`run` is keyed by the run id, `plugin` (one a plugin owns) `<plugin>:<key>`.

```ts
type AggregateKind = typeof AggregateKindSchema.Type;
```

## AggregateState

```ts
type AggregateState = typeof AggregateStateSchema.Type;
```

## APPROVAL_BYPASS_KINDS

```ts
const APPROVAL_BYPASS_KINDS: readonly ["bash", "toolEdit", "superYolo"]
```

## APPROVAL_POLICIES

```ts
const APPROVAL_POLICIES: readonly ["never", "ask", "yolo"]
```

## APPROVAL_POLICY_CONFIG_KEY

The approval policy's config key, the same on every host.

```ts
const APPROVAL_POLICY_CONFIG_KEY: "approvalPolicy"
```

## APPROVAL_POLICY_DEFAULT

```ts
const APPROVAL_POLICY_DEFAULT: ApprovalPolicy
```

## APPROVAL_POLICY_NO_INPUT_DEFAULT

The policy a `--no-input` run falls back to. Deliberately divergent from
{@link APPROVAL_POLICY_DEFAULT}: a run that cannot present a prompt
denies instead of hanging, and `buildCliContext` narrows the candidate list
to the explicit `--approval-policy` flag alone — a persisted or env-provided
`yolo` must not silently auto-approve a headless run that nobody is watching.
Changing that requires changing headless discipline, not just this constant.

```ts
const APPROVAL_POLICY_NO_INPUT_DEFAULT: ApprovalPolicy
```

## ApprovalBypassKind

```ts
type ApprovalBypassKind = (typeof APPROVAL_BYPASS_KINDS)[number];
```

## ApprovalGrants

```ts
type ApprovalGrants = typeof ApprovalPolicySnapshotSchema.Type;
```

## ApprovalGrantSource

The rows a bypass is read from: each run's parent edge and grants, as
the session view folds them.

```ts
interface ApprovalGrantSource<Id> {
  readonly runs: ReadonlyMap<Id, { readonly parentId: Id | null }>;
  readonly policy: ReadonlyMap<Id, ApprovalGrants>;
}
```

## ApprovalPolicy

```ts
type ApprovalPolicy = typeof ApprovalPolicySchema.Type;
```

## ApprovalPolicySchema

```ts
const ApprovalPolicySchema: Literals<readonly ["never", "ask", "yolo"]>
```

## AttachedMemoryMiss

An attached memory the opening could not read ({@link AttachedMemoryMissSchema}).

```ts
type AttachedMemoryMiss = typeof AttachedMemoryMissSchema.Type;
```

## Attention

What wants this window: the requests it can answer (the badge), and since
`previous` (none without it) the new ones and the runs that ended.

```ts
interface Attention<Request> {
  readonly requests: readonly Request[];
  readonly arrived: readonly Request[];
  readonly finished: readonly ReadRunView[];
}
```

## attentionOf

The one attention rule every host reads (the extension's badge, reveal and
chime, the desktop's dock badge, notifications, and rail): a request wants
the user when this window can answer it (not one on a run another process
holds or waiting for its run's resume), and a run when its outcome lands.

```ts
function attentionOf<View extends ReadSessionView>(
  view: View,
  previous?: ReadSessionView,
): Attention<View['requests'][number]>
```

## BashPermission

```ts
type BashPermission = typeof BashPermissionSchema.Type;
```

## blocksCaller

Whether a request blocks the tool that opened it: every kind the harness
opens does, and a plugin's request as it declares. One that does not
leaves its run working; its plugin's decision hook delivers the answer to
whichever process holds the run by then, so it stays open across every
resume. The folds and the decision door all read this one predicate.

```ts
const blocksCaller: (payload: { readonly kind: "toolEdit"; readonly data: { readonly requestId: string; readonly allowBypass: boolean; readonly runId: "" | (string & Brand<"RunId">); readonly path: string; readonly relativePath: string; readonly sourceTool: string; readonly addedLines: number; readonly removedLines: number; readonly content: string; }; } | { readonly kind: "bash"; readonly data: { readonly requestId: string; readonly runId: "" | (string & Brand<"RunId">); readonly allowBypass: boolean; readonly command: string; readonly cwd?: string | undefined; }; } | { readonly kind: "retry"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly operation: string; readonly errorDetails: { readonly message: string; readonly statusCode?: number | undefined; readonly statusText?: string | undefined; readonly provider?: string | undefined; readonly classification?: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; } | undefined; readonly requestId?: string | undefined; readonly partialText?: string | undefined; }; readonly model?: string | undefined; readonly credentialSwitch?: { readonly kind: "decline-route"; readonly route: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; readonly automatic: boolean; } | { readonly kind: "new-key"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | null | undefined; }; } | { readonly kind: "proposal"; readonly data: { readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly allowBypass: boolean; readonly task: boolean; readonly script?: { readonly title: string | null; readonly source: string; readonly calls: readonly { readonly toolName: string; readonly preview: string; }[]; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly options?: { readonly [x: string]: Json; } | null | undefined; }; } | { readonly kind: "planApproval"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly plan: { readonly objective: string; }; }; } | { readonly kind: "userQuestion"; readonly data: { readonly requestId: string; readonly runId: "" | (string & Brand<"RunId">); readonly allowBypass: boolean; readonly questions: readonly { readonly options: readonly { readonly label: string; readonly description?: string | null | undefined; }[]; readonly question: string; readonly header?: string | null | undefined; readonly multiSelect?: boolean | null | undefined; readonly allowFreeText?: boolean | null | undefined; }[]; readonly context?: string | null | undefined; }; } | { readonly kind: "plugin"; readonly plugin: string; readonly blocksCaller: boolean; readonly answers: readonly ("retry" | "approve" | "approve_and_goal" | "submit" | "answer" | "skip")[]; readonly data: { readonly [x: string]: Json; readonly requestId: string; readonly runId: string & Brand<"RunId">; }; }) => boolean
```

## Cancelled

Nothing is left to tell the user: they cancelled the operation, or the
host has already told them why it did not go through. No refusal notice
is needed.

```ts
class Cancelled extends Schema.TaggedError<Cancelled>()(
  'Cancelled',
  {},
)
```

## CHATGPT_CODEX_CONTEXT_WINDOW_SETTING

Bounds and copy for the ChatGPT-subscription input budget; unset, each
model takes the window the Codex backend grants it.

The stored unit is **thousands of tokens**, and the key says so. Every
budget in play is a round multiple of 1000 (272K, 400K, 872K), so a raw
token count is three zeros nobody wants to type and an off-by-1000 typo
lands inside the valid range instead of being rejected: `872` entered for
872,000 is a legal 872-token budget that puts every request over the limit,
and the failure then names a number the user never meant to set.

```ts
const CHATGPT_CODEX_CONTEXT_WINDOW_SETTING: Readonly<{ readonly configKey: "chatgptCodex.contextWindowK"; readonly tokensPerUnit: 1000; readonly min: 1; readonly max: 872; readonly unitLabel: "K tokens"; readonly description: "Input token budget for ChatGPT-subscription (Codex) routing, in thousands of tokens, mirroring Codex CLI's model_context_window. Unset, each model takes the window the Codex backend grants it (500 for GPT-6.1 Sol, 272 for the others); a value overrides it for every model, up to 872 (872,000 tokens). Automatic compaction may run earlier according to the separate compaction threshold. The model's output budget is added when displaying the total context window. The OpenAI backend enforces the real per-account limit — values above what your subscription allows fail and trigger compaction recovery."; }>
```

## CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY

Config key for the per-session child-run concurrency budget.

```ts
const CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY: "childRunConcurrencyBudget"
```

## CHILD_RUN_CONCURRENCY_BUDGET_SETTING

Bounds, default, and copy for `childRunConcurrencyBudget`. The value caps the
number of live native child model conversations one session runs at once.
Shared by the catalog row and the runtime reader so the two cannot disagree
about the range.

```ts
const CHILD_RUN_CONCURRENCY_BUDGET_SETTING: Readonly<{ readonly auto: 0; readonly defaultValue: 0; readonly min: 0; readonly max: 100; readonly description: "Maximum number of agents one task may run at once in the background; a script's agent() calls also run at most this many at once. 0 (the default) sizes it to this machine's CPU count. Agents beyond the budget wait for a slot to free."; }>
```

## CompactionActivityData

```ts
type CompactionActivityData =
  (typeof CompactionActivityDataSchema)['Type'];
```

## CompactionActivityOutcome

```ts
type CompactionActivityOutcome = Exclude<
  CompactionActivityData['state'],
  'started'
>;
```

## ConfigInspection

One key's stored values, by the scope that holds each.

```ts
type ConfigInspection<T = unknown> = Partial<
  Record<'globalValue' | 'workspaceValue', T>
>;
```

## ConfigTarget

Where a config write lands. `workspace` is the project's committable
`.texra/config.json`, which a cloned repository controls; `local` is this
user's private file for the workspace, under the storage root and never in
the project; `global` is the user's file for every workspace.

```ts
type ConfigTarget = 'global' | 'workspace' | 'local';
```

## configTreeRows

Config-file-backed rows from a record keyed by dotted path: the key and the
uniform `config` slot are derived, not restated. The record's declaration
order is the catalog order.

```ts
function configTreeRows(
  rows: Readonly<Record<string, Omit<StateSettingEntry, 'key' | 'slot'>>>,
): StateSettingEntry[]
```

## ContextManagementData

```ts
type ContextManagementData = typeof ContextManagementDataSchema.Type;
```

## ContextStateData

```ts
type ContextStateData = typeof ContextStateDataSchema.Type;
```

## countLines

Count the number of lines in a string.
Handles both Unix (\n) and Windows (\r\n) line endings.
A trailing newline does not count as an extra line.

- `@example` countLines('a\nb\nc') // 3
  countLines('a\nb\nc\n') // 3 (trailing newline ignored)
  countLines('') // 0

```ts
function countLines(text: string): number
```

## CredentialSwitchSchema

The move onto the user's own credential a failed model request offers,
decided once by the retry owner (`ModelInvoker`) from the recorded failure
and the route the failed model was bound on. Hosts render it; none of them
re-derives it from the error.

```ts
const CredentialSwitchSchema: Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>
```

## DatabaseAggregateClosed

A batch member targets an aggregate that is closed (deleted) or was
never created; nothing was written. The store's protocol, not the disk,
so it is never wrapped in `DatabaseWriteFailed`.

```ts
class DatabaseAggregateClosed extends Schema.TaggedError<DatabaseAggregateClosed>()(
  'DatabaseAggregateClosed',
  { aggregateId: AggregateIdSchema },
)
```

## DeclinableUsageRoute

```ts
type DeclinableUsageRoute = typeof DeclinableUsageRouteSchema.Type;
```

## DEFAULT_AGENT_MODEL

Default model used when a new agent run / proposal omits one. Single source of
truth shared by the agent config schema,
the main-view persisted state, and the progress-view proposal reconstruction —
so a change here propagates to all three instead of drifting per call site.
`DEFAULT_MODELS` leads with this model, so it must not be a Gemini id.

```ts
const DEFAULT_AGENT_MODEL: "openai/gpt-6.1-sol"
```

## DEFAULT_WORKFLOW_AGENT

Agent selected when launch input names none.

```ts
const DEFAULT_WORKFLOW_AGENT: "correct"
```

## descendantRuns

Every run under `rootRunId`, parents first: the topology `childIds`
(root to leaf) and `ancestors` (leaf to root) already state on every row,
so a host walks the view's own facts instead of re-deriving them.

```ts
function descendantRuns(
  view: Pick<ReadSessionView, 'runs'>,
  rootRunId: RunId | undefined,
  { includeRoot }: { includeRoot: boolean },
): readonly RunId[]
```

## DiffStats

```ts
type DiffStats = typeof DiffStatsSchema.Type;
```

## DiffStatsSchema

Schema for diff statistics where one side may be absent.

```ts
const DiffStatsSchema: Struct<{ readonly added: optional<Int>; readonly removed: optional<Int>; }>
```

## DispatchFacts

```ts
type DispatchFacts = typeof DispatchFactsSchema.Type;
```

## DisplaySessionEvent

```ts
type DisplaySessionEvent = typeof DisplaySessionEventSchema.Type;
```

## emptyRunEndOutput

The output of a run that ended before its flow produced one.

```ts
function emptyRunEndOutput(): RunEndOutput
```

## ensureError

Coerce any thrown value to an Error instance.

```ts
function ensureError(err: unknown): Error
```

## ErrorLogData

```ts
type ErrorLogData = typeof ErrorLogDataSchema.Type;
```

## escapeAttr

Escape for use inside a double-quoted HTML/XML attribute value.

```ts
function escapeAttr(s: string): string
```

## escapeText

Escape XML/HTML text content (element bodies).

```ts
function escapeText(s: string): string
```

## ExternalFileLocation

```ts
type ExternalFileLocation = typeof ExternalFileLocationSchema.Type;
```

## extractErrorMessage

Extract error message from Error objects or strings.
Returns `undefined` if the value is neither an Error nor a non-empty string.

Use this when you need optional extraction. For a guaranteed string, use
{@link toErrorMessage}.

```ts
function extractErrorMessage(err: unknown): string | undefined
```

## FileListEntry

```ts
type FileListEntry = typeof FileListEntrySchema.Type;
```

## FileLocation

```ts
type FileLocation = typeof FileLocationSchema.Type;
```

## fileLocationAddressPath

How a location is addressed in text that leaves the UI — copied run context,
follow-up prompts, subagent results. A run-storage location carries the
run that owns it, so its `/executions/...` route resolves without the
caller supplying one; every other kind reads as its display path.

```ts
function fileLocationAddressPath(location: FileLocation): string
```

## fileLocationDisplayPath

How a location reads as a path: workspace and run-storage files by their
relative path — that is how the user and the agent's file tools refer to
them — and external files by their absolute path, the only path they have.

This doubles as a location's comparable identity: two locations naming the
same file agree here, so output-to-base maps key on it.

```ts
function fileLocationDisplayPath(location: FileLocation): string
```

## FileLocationSchema

Discriminated union of all file location types

```ts
const FileLocationSchema: Union<readonly [Struct<{ readonly kind: Literal<"workspace">; readonly absolutePath: String; readonly relativePath: String; }>, Struct<{ readonly kind: Literal<"runStorage">; readonly absolutePath: String; readonly relativePath: String; readonly runId: brand<String, "RunId">; }>, Struct<{ readonly kind: Literal<"external">; readonly absolutePath: String; }>]>
```

## fileLocationShortDisplayPath

Like {@link fileLocationDisplayPath} but collapses an external location to
its basename, so a long absolute path (e.g. a run-storage file resolved as
external because it sits outside the workspace root) cannot dominate a UI
row or a prompt line. The full path stays on `absolutePath`.

```ts
function fileLocationShortDisplayPath(location: FileLocation): string
```

## FollowUpContent

```ts
type FollowUpContent = typeof FollowUpContentSchema.Type;
```

## FollowUpSender

```ts
type FollowUpSender = typeof FollowUpSenderSchema.Type;
```

## formatError

Format an error with a prefix for logging or user messages.

```ts
function formatError(prefix: string, err: unknown): string
```

## formatHunkLines

Hunks as unified-diff text lines, each preceded by its header. One header
policy: a `,1` range is omitted, the form `diff -u` and `git diff` emit.

```ts
function formatHunkLines(hunks: ToolEditContent['hunks']): string[]
```

## generateRunId

Mint a run id: 12 lowercase hex chars (48 bits of entropy), the first
digits of a random UUID, every one of which is random. One of the two
minting sites (`deriveRunId` is the other), so the brand is applied here
and nowhere downstream. Any other random id is `crypto.randomUUID()`.

```ts
function generateRunId(): RunId
```

## getBasename

Extract the base name (filename) from a file path.
Handles platform-specific separators (\ on Windows, / on Unix).

- `@example` getBasename('/home/user/document.pdf') // returns 'document.pdf'
  getBasename('C:\\Users\\file.txt')     // returns 'file.txt'
  getBasename('/path/to/')               // returns 'to'
  getBasename('/')                       // returns ''

```ts
function getBasename(filePath: string | undefined | null): string
```

## getFileStem

Basename without its final extension (`'notes'` for `'dir/notes.md'`).
Dotfiles keep their name (`'.gitignore'` → `'.gitignore'`).

```ts
function getFileStem(filePath: string | undefined | null): string
```

## getModelLabel

Resolve a persisted model id to its static user-facing catalogue label.

```ts
function getModelLabel(model: string): string
```

## getProposalFileGroups

```ts
function getProposalFileGroups(
  data: ProposalFileFields,
): ProposalFileGroup[]
```

## GlobalStateKey

```ts
const GlobalStateKey: Readonly<{ readonly MEMORY_ENABLED: "memory.enabled"; readonly SCRIPT_ONLY: "codeMode.scriptOnly"; readonly ALLOW_ORCHESTRATOR_KILL: "allowOrchestratorKill"; readonly DETACH_SUBAGENTS_ON_STOP: "detachSubagentsOnStop"; readonly MODEL_SELECTION: "modelSelection"; readonly HELPER_MODEL: "helperModel"; readonly REASONING_LEVELS: "reasoningLevels"; readonly CUSTOM_AGENT_DIR: "customAgentDir"; readonly GLM_CODING_PLAN: "glm.codingPlan"; readonly KIMI_CODE_PREFER: "kimiCode.prefer"; readonly WEBSOCKET_OPENAI: "websocket.openai"; readonly DISABLED_TOOLS: "tools.disabled"; readonly MCP_REVISION_KEY: "mcp.revisionKey"; readonly INSTALLED_PLUGINS: "plugins.installed"; readonly ACTIVE_TEAM_ID: "onboarding.defaultTeamId"; }>
```

## GOAL_MAX_COST_SETTING

Bounds, default, and copy for `goal.maxCostUsd`: what a goal's rounds may
spend before it pauses instead of starting another round, and `0`
disables the cap. Read when the goal launches, into its script. Shared by
the catalog row and the goal launch so the two cannot disagree about the
range.

```ts
const GOAL_MAX_COST_SETTING: Readonly<{ readonly configKey: "goal.maxCostUsd"; readonly defaultValue: 5; readonly min: 0; readonly max: 10000; readonly description: "Spend in US dollars, across its rounds, at which an autonomous goal pauses instead of starting another round. Raise it, then run the goal again to continue. Set to 0 to remove the cap (not recommended with auto-approve on your own API key)."; }>
```

## GOAL_STRATEGY_SETTING

Default and copy for `goal.strategy`: the script module whose `goal`
export a plan run as a goal calls. The default is the goal plugin's own
module; a `scriptModules` entry of any plugin that is on may replace it. Read when
the goal launches.

```ts
const GOAL_STRATEGY_SETTING: Readonly<{ readonly configKey: "goal.strategy"; readonly defaultValue: "builtIn:goal"; readonly description: "The script module a plan run as a goal runs, by its import specifier (`builtIn:<module>`): its `goal(objective, { maxCostUsd })` export decides the rounds, what context each starts from and when to stop, and resolves to the goal's result. Defaults to the goal plugin's own module."; }>
```

## GoalResultSchema

A goal's result: what its strategy, the `goal` export of the script
module the `goal.strategy` setting names, returns, and so the structured
output its run ends with. `completed` when a round verified the
objective, `paused` with the reason otherwise. A pause is a result, not a
waiting run: work continues through a new goal or a new turn.

```ts
const GoalResultSchema: Union<readonly [Struct<{ readonly rounds: Int; readonly spent: Finite; readonly report: String; readonly outcome: Literal<"completed">; }>, Struct<{ readonly rounds: Int; readonly spent: Finite; readonly report: String; readonly outcome: Literal<"paused">; readonly pause: Union<readonly [Struct<{ readonly reason: Literal<"needs_user">; }>, Struct<{ readonly reason: Literal<"round_failed">; readonly error: Struct<{ readonly name: String; readonly message: String; }>; }>, Struct<{ readonly reason: Literal<"no_verdict">; readonly response: String; }>, Struct<{ readonly reason: Literal<"spend_cap">; readonly maxCostUsd: Finite; }>]>; }>]>
```

## HARNESS_INSTRUCTION_KEY

The instruction keys the harness itself emits as
{@link RequestShowInstructionPayload.key}. A key names the notice for the
host's "never remind again" state; an embedder decides what each of these
offers beside the message (TeXRA: the buttons that set a key or open a
guide). An embedder's own notices use keys of their own.

```ts
const HARNESS_INSTRUCTION_KEY: { readonly MISSING_API_KEY: "missingApiKey"; readonly MODEL_NOT_RECOGNIZED: "modelNotRecognized"; readonly RESUME_REFUSED: "resumeRefused"; }
```

## HarnessInstructionKey

```ts
type HarnessInstructionKey =
  (typeof HARNESS_INSTRUCTION_KEY)[keyof typeof HARNESS_INSTRUCTION_KEY];
```

## HookEvent

```ts
type HookEvent = typeof HookEventSchema.Type;
```

## HumanInputDecision

Whether a human-input request may be shown, or why it settles denied.

```ts
type HumanInputDecision =
  | 'present'
  | {
      readonly deny: 'yolo-no-human' | 'policy' | 'unpresentable';
    };
```

## InlinePersona

An inline persona as an embedder writes it (before defaults).

```ts
type InlinePersona = typeof InlinePersonaSchema.Encoded;
```

## InlinePersonaSchema

A persona an embedder passes inline (`StartInput.agent`) instead of a
file: the same definition with nothing a file alone can mean. It has no
bundled original and no plugin's block (a task is its plugin's recipe);
each is refused as an unrecognized key.

```ts
const InlinePersonaSchema: Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>
```

## InputHistoryRecord

```ts
type InputHistoryRecord = typeof InputHistoryRecordSchema.Type;
```

## InstalledPluginSchema

One installed plugin, persisted as a row of the `plugins.installed`
state: the one install record every host reads and writes (a CLI's
plugin command, a settings page). The plugin keeps its own manifest
(`.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`); this row is
where it lives, whether it is
enabled, the trust given to it, and what stands in for a manifest the
plugin does not have (the marketplace entry's skill directories, version
and description).

`name` takes the skill-name grammar, which also makes it a safe single path
segment for the managed `plugins/<name>` directory. `commit` is set exactly
when the harness fetched the plugin with git and owns its directory; a local
plugin is referenced in place and has none.

```ts
const InstalledPluginSchema: Struct<{ readonly name: decodeTo<String, String, never, never>; readonly source: String; readonly ref: optional<String>; readonly commit: optional<String>; readonly path: String; readonly skills: $Array<String>; readonly version: optional<String>; readonly description: optional<String>; readonly enabled: Boolean; readonly trust: optional<Struct<{ readonly version: NullOr<String>; readonly digest: String; }>>; }>
```

## Invalid

The request could not be parsed: a bridge's answer, never the runtime's.

```ts
class Invalid extends Schema.TaggedError<Invalid>()('Invalid', {
  reason: Schema.String,
})
```

## isEmptyUsage

Whether usage stats are all zeros (effectively empty).

```ts
function isEmptyUsage(usage: TokenUsageStats): boolean
```

## isInterrupted

Whether nobody drives the run although it has not ended: its process
stopped before it finished, and a resume continues it.

```ts
const isInterrupted: (run: Pick<{ readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly description: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly takesFollowUps: boolean; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly recipe: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly outcome: "completed" | "cancelled" | "failed" | null; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly parentId: (string & Brand<"RunId">) | null; readonly facts: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly position: "waiting" | "ready" | "running"; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly holder: "here" | "none"; readonly statusNotice: { readonly kind: "damaged" | "earlierBuild"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly turnStartedAt: number | null; readonly runStartedAt: number | null; readonly launchParentId: (string & Brand<"RunId">) | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly parentCard: string | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly approval: "own" | "descendant" | "none"; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly latestLine: string | null; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly phaseCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly media?: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | TypeOptionalKeys<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly rawMessage: optional<String>; readonly operation: optional<String>; readonly model: optional<String>; }>; readonly value: string; }[]; readonly failure?: { readonly message: string; readonly classification: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; }; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: string; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: string; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: string; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; }; readonly phase?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly source?: string | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly quotaFallback?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly taskGroups: readonly { readonly id: string; readonly name: string; readonly status: "completed" | "cancelled" | "failed" | "running"; readonly startTime: number; readonly kind?: "script" | "run" | "session" | undefined; readonly endTime?: number | undefined; readonly parentGroupId?: string | undefined; }[]; readonly settledRows: number; }; readonly agentScope?: readonly string[] | null | undefined; }, "outcome" | "holder">) => boolean
```

## isModelOptionAvailable

Whether an option row can be run as shipped: `readModelOptions`
already resolved the access question, so a caller only has to read its
verdict. Lives with the kind so delegation's model list and the CLI's
picker can never drift apart on what "available" means.

```ts
function isModelOptionAvailable(model: {
  readonly availability?: ModelAvailabilityKind;
}): boolean
```

## isPackagedAgentSource

True for the sources whose definitions are read in place and are not the
user's to edit: the bundled one, and an installed
plugin's. Every surface that offers to open one presents it read-only and
points edits at the custom copy; the extension additionally registers the
bundled directories `writable: false` for its file tools.

```ts
function isPackagedAgentSource(source: AgentSource): boolean
```

## isPlainAgentIdentity

Whether an identity denotes a native agent rather than an external CLI.

```ts
function isPlainAgentIdentity(
  identity: RunIdentity | null | undefined,
): boolean
```

## isRunId

Whether a string is a run id, as {@link RunIdSchema} reads it.

```ts
const isRunId: <I>(input: I) => input is I & string & Brand<"RunId">
```

## isTaskConfig

Whether the run is a task (an agent carrying a plugin's block, run on
its recipe): its value and its children's spend are its output, its end
its record; it resumes from its checkpoint, its opening rebuilt.

```ts
const isTaskConfig: (config: { readonly name: string; readonly instruction: string; readonly workingDirectory?: string | undefined; readonly model?: string | undefined; } | { readonly agent?: string | undefined; readonly script?: { readonly kind: "background"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly timeoutMs?: number | null | undefined; } | { readonly kind: "recipe"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly block: string; readonly options: { readonly [x: string]: Json; }; readonly timeoutMs?: number | null | undefined; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly model?: string | undefined; readonly instruction?: string | undefined; readonly editedFile?: string | null | undefined; readonly inputFiles?: readonly string[] | undefined; readonly contextFiles?: readonly string[] | undefined; readonly mediaFiles?: readonly string[] | undefined; readonly outputFiles?: readonly string[] | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly asCaller?: boolean | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly displayInstruction?: string | null | undefined; readonly memories?: readonly string[] | undefined; readonly cli?: { readonly outputFile?: string | null | undefined; readonly outputDirectory?: string | null | undefined; readonly expectedOutputFiles?: readonly string[] | null | undefined; readonly teamId?: string | null | undefined; } | null | undefined; readonly delegationAgentScope?: readonly string[] | null | undefined; readonly outputSchema?: { readonly [x: string]: unknown; } | null | undefined; }) => boolean
```

## isUnreadable

Whether this build cannot read the run's rows (`RunNoticeSchema`).

```ts
const isUnreadable: (run: Pick<{ readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly description: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly takesFollowUps: boolean; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly recipe: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly outcome: "completed" | "cancelled" | "failed" | null; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly parentId: (string & Brand<"RunId">) | null; readonly facts: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly position: "waiting" | "ready" | "running"; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly holder: "here" | "none"; readonly statusNotice: { readonly kind: "damaged" | "earlierBuild"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly turnStartedAt: number | null; readonly runStartedAt: number | null; readonly launchParentId: (string & Brand<"RunId">) | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly parentCard: string | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly approval: "own" | "descendant" | "none"; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly latestLine: string | null; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly phaseCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly media?: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | TypeOptionalKeys<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly rawMessage: optional<String>; readonly operation: optional<String>; readonly model: optional<String>; }>; readonly value: string; }[]; readonly failure?: { readonly message: string; readonly classification: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; }; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: string; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: string; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: string; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; }; readonly phase?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly source?: string | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly quotaFallback?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly taskGroups: readonly { readonly id: string; readonly name: string; readonly status: "completed" | "cancelled" | "failed" | "running"; readonly startTime: number; readonly kind?: "script" | "run" | "session" | undefined; readonly endTime?: number | undefined; readonly parentGroupId?: string | undefined; }[]; readonly settledRows: number; }; readonly agentScope?: readonly string[] | null | undefined; }, "statusNotice">) => boolean
```

## isWorking

Whether the run is working a turn in this process right now (a pending
approval or question is still the turn's).

```ts
const isWorking: (run: Pick<{ readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly description: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly takesFollowUps: boolean; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly recipe: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly outcome: "completed" | "cancelled" | "failed" | null; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly parentId: (string & Brand<"RunId">) | null; readonly facts: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly position: "waiting" | "ready" | "running"; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly holder: "here" | "none"; readonly statusNotice: { readonly kind: "damaged" | "earlierBuild"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly turnStartedAt: number | null; readonly runStartedAt: number | null; readonly launchParentId: (string & Brand<"RunId">) | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly parentCard: string | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly approval: "own" | "descendant" | "none"; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly latestLine: string | null; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly phaseCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly media?: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | TypeOptionalKeys<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly rawMessage: optional<String>; readonly operation: optional<String>; readonly model: optional<String>; }>; readonly value: string; }[]; readonly failure?: { readonly message: string; readonly classification: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; }; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: string; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: string; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: string; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; }; readonly phase?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly source?: string | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly quotaFallback?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly taskGroups: readonly { readonly id: string; readonly name: string; readonly status: "completed" | "cancelled" | "failed" | "running"; readonly startTime: number; readonly kind?: "script" | "run" | "session" | undefined; readonly endTime?: number | undefined; readonly parentGroupId?: string | undefined; }[]; readonly settledRows: number; }; readonly agentScope?: readonly string[] | null | undefined; }, "position" | "holder">) => boolean
```

## JsonValue

```ts
type JsonValue = typeof JsonValueSchema.Type;
```

## JsonValueSchema

Any JSON-serializable value. Shared home for `Schema.Json` so structured tool
output, script results, and agent run results validate the
same contract instead of re-declaring it per module.

```ts
const JsonValueSchema: Codec<Json, Json, never, never>
```

## LaunchNotice

A refused launch's notice ({@link LaunchNoticeSchema}).

```ts
type LaunchNotice = typeof LaunchNoticeSchema.Type;
```

## LaunchNoticeSchema

The notice a refused launch carries for its caller to show
(`AgentError.notice`), as the presentation event and payload a host's
`emit` takes: the instruction for a model the build does not recognize,
or the agent the launch named that the catalog does not hold. The launch
shows nothing itself; the caller shows this where it shows the failure.

```ts
const LaunchNoticeSchema: Union<readonly [Struct<{ readonly event: Literal<"requestShowInstruction">; readonly payload: Struct<{ readonly key: String; readonly message: String; readonly showSuppress: optional<Boolean>; }>; }>, Struct<{ readonly event: Literal<"agentNotFound">; readonly payload: Struct<{ readonly agentName: String; }>; }>]>
```

## LineCountSchema

Nonnegative line-count schema shared by tool results, approvals, and output
diff statistics.

```ts
const LineCountSchema: Int
```

## listingTypeOf

The listing type the fold keys `latest` by, from the kind's listing class,
or null for a kind the listing leaves out. `plugin.fact` holds several
kinds on one type, so it is read grouped by kind as well (`listingKeyOf`,
`Database`).

```ts
function listingTypeOf(
  event: Pick<SessionEventDraft, 'type'>,
): string | null
```

## LoadedMediaMetadata

```ts
type LoadedMediaMetadata = typeof LoadedMediaMetadataSchema.Type;
```

## LocalRuntimeState

```ts
type LocalRuntimeState = typeof LocalRuntimeStateSchema.Type;
```

## LogicalId

A logical id that is not itself an already-qualified aggregate key: the
brand key `Schema.brand` stamps on an `AggregateId` is refused here.

```ts
type LogicalId = string & {
  readonly '~effect/Brand'?: { readonly AggregateId?: never };
};
```

## LogLevel

```ts
type LogLevel = typeof LogLevelSchema.Type;
```

## McpToolOutput

The output an MCP tool call reports (`McpToolOutputSchema`).

```ts
type McpToolOutput = typeof McpToolOutputSchema.Type;
```

## MediaAttachmentKind

```ts
type MediaAttachmentKind = typeof MediaAttachmentKindSchema.Type;
```

## MemoryViewItem

```ts
type MemoryViewItem = typeof MemoryViewItemSchema.Type;
```

## MemoryViewItemSchema

```ts
const MemoryViewItemSchema: Struct<{ readonly displayPath: String; readonly storagePath: String; readonly size: Number; readonly mtime: String; readonly lineCount: optional<Number>; readonly preview: optional<String>; readonly previewError: optional<Boolean>; readonly modifiedBy: optional<String>; readonly pinned: optional<Boolean>; }>
```

## MESSAGE_TYPES

```ts
const MESSAGE_TYPES: { readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }
```

## MessageType

```ts
type MessageType = typeof MessageTypeSchema.Type;
```

## MODEL_AVAILABILITY_STATUS

What a kind means: whether a run can use the model, and whether the block is
a missing key (a surface's words for each kind are the app's). Declared once
here, next to the kind, so the answer is carried on the wire as the kind
alone and every host reads the same table instead of pre-fanned fields.

Written with `as const satisfies` so each `available` literal survives for
`computeModelOptions`'s derivation of the unavailable kinds, while a missing
or misshapen kind is still a compile error, and frozen to the depth it is
read at: the table crosses into every host that decides whether a model can
run, and `readonly` is compile-time only.

```ts
const MODEL_AVAILABILITY_STATUS: { readonly 'provider-key': { readonly available: true; readonly requiresKey: false; }; readonly 'missing-key': { readonly available: false; readonly requiresKey: true; }; readonly 'key-unreadable': { readonly available: false; readonly requiresKey: false; }; readonly 'subscription-access': { readonly available: true; readonly requiresKey: false; }; readonly 'xai-subscription-access': { readonly available: true; readonly requiresKey: false; }; readonly retired: { readonly available: false; readonly requiresKey: false; }; readonly unserved: { readonly available: false; readonly requiresKey: false; }; readonly 'unknown-model': { readonly available: false; readonly requiresKey: false; }; }
```

## MODEL_COMPACTION_THRESHOLD_SETTING

Bounds, default, and copy for `model.compactionThresholdPercent`. The value
is the share of the model's context window that triggers automatic
compaction, and `0` disables it. Shared by the catalog row and the runtime
reader so the two cannot disagree about the range.

```ts
const MODEL_COMPACTION_THRESHOLD_SETTING: Readonly<{ readonly configKey: "model.compactionThresholdPercent"; readonly defaultValue: 75; readonly min: 0; readonly max: 100; readonly description: "When the conversation reaches this percentage of the model's context limit, earlier messages are summarized automatically to free up space. Lower values trigger summarization sooner. Set to 0 to disable."; }>
```

## MODEL_RETRY_MAX_ATTEMPTS_SETTING

Bounds, default, and copy for `model.retry.maxAttempts`. The value is the
number of automatic retries after the initial model request. Shared by the
catalog row's schema and its copy so the two cannot disagree about the range.

```ts
const MODEL_RETRY_MAX_ATTEMPTS_SETTING: Readonly<{ readonly configKey: "model.retry.maxAttempts"; readonly defaultValue: 2; readonly min: 0; readonly max: 5; readonly description: "Additional automatic retries after the initial model request (0–5). A resumed request keeps the retries it already used."; }>
```

## ModelAvailabilityKind

Why a model option can or cannot run.

```ts
type ModelAvailabilityKind = typeof ModelAvailabilityKindSchema.Type;
```

## ModelAvailabilityKindSchema

Why a model option can or cannot run, as it travels on the wire.

```ts
const ModelAvailabilityKindSchema: Literals<readonly ["provider-key", "missing-key", "key-unreadable", "retired", "unserved", "subscription-access", "xai-subscription-access", "unknown-model"]>
```

## ModelBackend

Who serves a run's conversation ({@link ModelBackendSchema}).

```ts
type ModelBackend = typeof ModelBackendSchema.Type;
```

## needsUser

Whether the run or a run under it needs the user: a request of its own
waits here, it is interrupted, or a descendant needs the user. Outranks a
surface's collapsed choice.

```ts
function needsUser(
  run: ReadRunView,
  runs: ReadonlyMap<RunId, ReadRunView>,
): boolean
```

## NormalizedToolUse

The flat, renderer-friendly tool-use view `normalizeToolUse`
derives from a parsed {@link ToolUseLog}. Declared as a
plain type, not a schema: the producer builds this shape field-by-field and
nothing ever parses it, so a schema would own no boundary.

```ts
type NormalizedToolUse = {
  toolName: string;
  errorText: string;
  outputText: string;
  exitCode?: number;
  userInstructionText: string;
  input: unknown;
  isUserFeedback: boolean;
  headerSummary: string;
  status?: ToolCallStatus;
  card?: ToolCard;
};
```

## NormalizedUsage

Normalized, priced usage of one call ({@link NormalizedUsageSchema}).

```ts
type NormalizedUsage = typeof NormalizedUsageSchema.Type;
```

## normalizeFilePath

Normalize a file path to forward slashes for consistent comparisons.

```ts
function normalizeFilePath(filePath: string): string
```

## NullableFileFieldsSchema

Used by AgentConfig where `editedFile` may be null.

```ts
const NullableFileFieldsSchema: Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; }>
```

## OpenFilePayload

Open a file for the person, beside what they are looking at, and build
and show it if the host can.

```ts
interface OpenFilePayload {
  location: FileLocation;
  preserveFocus: boolean;
}
```

## OutcomeSchema

What the runtime answers with: a typed value the host renders.

```ts
const OutcomeSchema: Union<readonly [Struct<{ readonly kind: Literal<"done">; }>, Struct<{ readonly kind: Literal<"followUp">; readonly id: String; readonly status: Literals<readonly ["sent", "queued"]>; readonly receipt: Union<readonly [Struct<{ readonly state: Literal<"accepted">; }>, Struct<{ readonly state: Literal<"incorporated">; readonly turn: Int; }>, Struct<{ readonly state: Literal<"answered">; readonly turn: optional<Int>; readonly answer: Int; }>, Struct<{ readonly state: Literal<"unanswered">; readonly turn: optional<Int>; readonly reason: Literals<readonly ["failed", "cancelled", "completed", "noop", "ended", "closed"]>; readonly error: optional<String>; }>]>; }>, Struct<{ readonly kind: Literal<"receipt">; readonly receipt: Union<readonly [Struct<{ readonly state: Literal<"accepted">; }>, Struct<{ readonly state: Literal<"incorporated">; readonly turn: Int; }>, Struct<{ readonly state: Literal<"answered">; readonly turn: optional<Int>; readonly answer: Int; }>, Struct<{ readonly state: Literal<"unanswered">; readonly turn: optional<Int>; readonly reason: Literals<readonly ["failed", "cancelled", "completed", "noop", "ended", "closed"]>; readonly error: optional<String>; }>]>; }>, Struct<{ readonly kind: Literal<"forked">; readonly runId: brand<String, "RunId">; }>, Struct<{ readonly kind: Literal<"preview">; readonly preview: NullOr<Struct<{ readonly originalContent: String; readonly proposedContent: String; readonly hunks: $Array<Struct<{ readonly oldStart: Int; readonly oldLines: Int; readonly newStart: Int; readonly newLines: Int; readonly lines: $Array<String>; }>>; readonly firstChangedLine: NullOr<Int>; }>>; }>, Struct<{ readonly kind: Literal<"runFiles">; readonly result: Union<readonly [Struct<{ readonly status: Literal<"done">; readonly to: optional<String>; }>, Struct<{ readonly status: Literal<"noFiles">; }>, Struct<{ readonly status: Literal<"error">; readonly error: String; }>]>; }>]>
```

## OwnerId

The identity of the process that wrote a row (`origin`).

```ts
type OwnerId = typeof OwnerIdSchema.Type;
```

## parseApprovalPolicy

```ts
function parseApprovalPolicy(input: string): ApprovalPolicy | undefined
```

## PendingRequest

A request a run waits on a person for, as `SessionView` lists it:
which run asks, the request's id, and its payload (`payload.kind` is
what is asked: a command, an edit, a plan, a retry, a question).

```ts
type PendingRequest = SessionView['requests'][number];
```

## PermissionPayload

A pending request's payload, as {@link PermissionPayloadSchema} reads it.

```ts
type PermissionPayload = typeof PermissionPayloadSchema.Type;
```

## Persona

A persona with its defaults applied: what a run is offered and told.

```ts
type Persona = typeof PersonaSchema.Type;
```

## Plan

```ts
type Plan = typeof PlanSchema.Type;
```

## PlanApprovalPermission

```ts
type PlanApprovalPermission =
  (typeof PlanApprovalPermissionSchema)['Type'];
```

## planOf

The plan the user last approved in `run` (its `RunView.facts`), if any.

```ts
function planOf(run: {
  readonly facts: Readonly<Record<string, unknown>>;
}): Plan | null
```

## planSummaryLine

One-line label for a plan document: its first line of prose. A markdown
heading (`### Objective`) names a section rather than the plan, so it
labels the plan, markers stripped, only when the plan has no prose.

```ts
function planSummaryLine(objective: string): string
```

## PluginRequest

A request a plugin opens (`PermissionPayload`'s plugin case).

```ts
type PluginRequest = typeof PluginRequestSchema.Type;
```

## previewLabel

Truncate `text` to a fixed preview width. Unlike {@link truncateSummary},
this does not collapse whitespace first, so a multi-line `text` (an agent
prompt, say) keeps its embedded newlines up to the budget — every call
site here already passes text that is one line in practice.

```ts
function previewLabel(text: string): string
```

## ProcessExit

```ts
type ProcessExit = typeof ProcessExitSchema.Type;
```

## ProgressPermissionKind

The one request kind vocabulary, read off the payload union. The
`request.opened` fact and every surface that lists pending requests key
off it, so a spelling that drifts fails to compile.

```ts
type ProgressPermissionKind = PermissionPayload['kind'];
```

## ProposalFileFields

File fields shape consumed by {@link getProposalFileGroups} — the helper
behind every proposal file list (tool-row model, ProposalRequestPanel,
CLI AgentProposal modal, approval summaries).

```ts
interface ProposalFileFields {
  readonly inputFiles?: readonly string[];
  readonly contextFiles?: readonly string[];
  readonly mediaFiles?: readonly string[];
  readonly outputFiles?: readonly string[];
  readonly memories?: readonly string[];
}
```

## ProposalFileGroup

```ts
interface ProposalFileGroup {
  label: string;
  files: readonly string[];
  /** When false, files are virtual paths that should not be opened via workspace file commands. */
  clickable: boolean;
}
```

## PROVIDER_ENDPOINT_STATE_ENTRIES

The providers with a custom-endpoint setting, in catalog order.

```ts
const PROVIDER_ENDPOINT_STATE_ENTRIES: readonly [{ id: "openai"; displayName: string; endpointKey: "endpoint.openai"; }, { id: "anthropic"; displayName: string; endpointKey: "endpoint.anthropic"; }, { id: "google"; displayName: string; endpointKey: "endpoint.google"; }, { id: "xai"; displayName: string; endpointKey: "endpoint.xai"; }, { id: "deepseek"; displayName: string; endpointKey: "endpoint.deepseek"; }, { id: "moonshot"; displayName: string; endpointKey: "endpoint.moonshot"; }, { id: "dashscope"; displayName: string; endpointKey: "endpoint.dashscope"; }, { id: "minimax"; displayName: string; endpointKey: "endpoint.minimax"; }, { id: "glm"; displayName: string; endpointKey: "endpoint.glm"; }, { id: "meta"; displayName: string; endpointKey: "endpoint.meta"; }]
```

## providerEndpointKey

The custom-endpoint setting key of a provider, if it offers one.

```ts
function providerEndpointKey(
  provider: string,
): (typeof PROVIDER_ENDPOINT_STATE_ENTRIES)[number]['endpointKey'] | undefined
```

## ProviderError

A provider failure as a host reads it: the retry record with its raw body.

```ts
type ProviderError = typeof ProviderErrorObjectSchema.Type;
```

## providerRegionSetting

The region toggle of a provider, if the provider has two platforms.

```ts
function providerRegionSetting(
  provider: string,
): (typeof PROVIDER_REGION_SETTINGS)[number] | undefined
```

## qualifyAggregateId

Qualify a logical id once. An already-qualified key is not an input.

```ts
function qualifyAggregateId(kind: 'run', logicalId: RunId): AggregateId;
```

## QueuedFollowUp

A follow-up queued for the run and not yet consumed, as its row holds it.

```ts
type QueuedFollowUp = Pick<
  Extract<SessionEvent, { type: 'followup.queued' }>,
  'followUpId' | 'content' | 'holdUntil' | 'control' | 'commit'
>;
```

## ReadonlyDeep

A runtime value as a host or an embedder holds it: read-only all the
way down, every map, array, and record included. The value itself is not copied
(the fold publishes immutable levels); the type is what keeps a write
from reaching it. A primitive stays itself, so a branded id (a `RunId`)
is still that id.

```ts
type ReadonlyDeep<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | ((...args: never[]) => unknown)
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<K, ReadonlyDeep<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<ReadonlyDeep<V>>
      : T extends readonly (infer E)[]
        ? readonly ReadonlyDeep<E>[]
        : T extends object
          ? { readonly [P in keyof T]: ReadonlyDeep<T[P]> }
          : T;
```

## readTraceFacts

A parsed trace with each plugin fact checked as the store checks it,
against the harness's built-in fact kind (the goal's plan) and the app's
plugin fact kinds (`appFactKinds`). A fact at another version than its
kind's, or whose value the kind's schema rejects, throws, naming it, as
does a retired built-in fact no current plugin owns; one whose plugin
this build lacks is kept as written, marked `unavailable`, as the store
reads it.

```ts
function readTraceFacts(
  document: TraceDocument,
  appFactKinds: readonly TraceFactKind[],
): TraceDocument
```

## recipeBlockOf

The block key of the plugin whose recipe the run opened on
(`script.block`), or null for a run that is no task.

```ts
const recipeBlockOf: (config: { readonly name: string; readonly instruction: string; readonly workingDirectory?: string | undefined; readonly model?: string | undefined; } | { readonly agent?: string | undefined; readonly script?: { readonly kind: "background"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly timeoutMs?: number | null | undefined; } | { readonly kind: "recipe"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly block: string; readonly options: { readonly [x: string]: Json; }; readonly timeoutMs?: number | null | undefined; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly model?: string | undefined; readonly instruction?: string | undefined; readonly editedFile?: string | null | undefined; readonly inputFiles?: readonly string[] | undefined; readonly contextFiles?: readonly string[] | undefined; readonly mediaFiles?: readonly string[] | undefined; readonly outputFiles?: readonly string[] | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly asCaller?: boolean | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly displayInstruction?: string | null | undefined; readonly memories?: readonly string[] | undefined; readonly cli?: { readonly outputFile?: string | null | undefined; readonly outputDirectory?: string | null | undefined; readonly expectedOutputFiles?: readonly string[] | null | undefined; readonly teamId?: string | null | undefined; } | null | undefined; readonly delegationAgentScope?: readonly string[] | null | undefined; readonly outputSchema?: { readonly [x: string]: unknown; } | null | undefined; }) => string | null
```

## referencedAggregates

Aggregate identities introduced by a fact and its declared lifecycle edges.

```ts
function referencedAggregates(event: SessionEvent): AggregateId[]
```

## Rejected

The runtime refused the request for a worded reason, which is also its
`message`, so a caller that only formats errors still shows why.

```ts
class Rejected extends Schema.TaggedError<Rejected>()('Rejected', {
  reason: Schema.String,
  docsPage: Schema.optional(Schema.String),
})
```

## requestAnswerability

```ts
function requestAnswerability(
  run: ReadRunView,
  payload: PermissionPayload,
): RequestAnswerability
```

## RequestAnswerability

Whether this window can answer a pending request: the one rule the host's
attention badge and the request card both read, matching what
`SessionRequests.decide` accepts. A request that blocks its caller is
answered by the fiber waiting on it, so only while its run waits here; an
interrupted run has to be resumed first. One that does not, at any time.

```ts
type RequestAnswerability = 'answerable' | 'resume';
```

## RequestDecision

```ts
type RequestDecision = typeof RequestDecisionSchema.Type;
```

## RequestError

How a runtime request fails: one of the tagged errors above.

```ts
type RequestError = typeof RequestErrorSchema.Type;
```

## RequestErrorSchema

The wire form of a request's failure: the classes themselves.

```ts
const RequestErrorSchema: Union<readonly [typeof RunActive, typeof Unavailable, typeof Cancelled, typeof Rejected, typeof Conflict, typeof Invalid, typeof Internal]>
```

## RequestShowErrorPayload

{@link RequestShowErrorPayloadSchema}'s value.

```ts
type RequestShowErrorPayload = typeof RequestShowErrorPayloadSchema.Type;
```

## RequestShowErrorPayloadSchema

Show an error message via a host notification.

```ts
const RequestShowErrorPayloadSchema: Struct<{ readonly message: String; readonly docsPage: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; }>
```

## RequestShowInstructionPayload

Show a suppressible instruction message.

```ts
interface RequestShowInstructionPayload {
  /** Names the notice: the host's suppression state, and what an embedder
   *  offers beside it ({@link HARNESS_INSTRUCTION_KEY} for the harness's). */
  key: string;
  message: string;
  showSuppress?: boolean;
}
```

## resolveBypass

Who bypasses one kind's prompts for a run: the nearest run in its ancestry
(itself first) that decides the kind, by its autonomous goal's grant
(`goal`) or a human's value (`human` when on); `null` when nothing grants
it. Past a `parent` value only human values decide. The one reading of the
grants, for enforcement and every surface.

```ts
function resolveBypass<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
  kind: ApprovalBypassKind,
): 'goal' | 'human' | null
```

## ResponseCut

The limit that ended an answer early: the model's output budget
(`length`), or the provider's content filter.

```ts
type ResponseCut = typeof ResponseCutSchema.Type;
```

## ResumeRefusal

One reason a resume is refused ({@link ResumeRefusalSchema}).

```ts
type ResumeRefusal = typeof ResumeRefusalSchema.Type;
```

## ResumeRefusalSchema

Why a persisted run is not continued here: the one answer a resume, a
message to a run with no loop here, a run's records and its view give.
`finished` (nothing left to continue from), `blocked`
({@link ResumeBlockedSchema}), `unusableCheckpoint` (its saved state is
there but cannot be continued: never `finished`, which would say it ended
normally), `earlierBuild` (an earlier build wrote its rows),
`pluginUnavailable` (it holds a fact of `plugin`, which this process does
not load, `cause` the fact's reason: it continues once a process loads
it), or `notResumable` (it was deleted, or its input is closed).

```ts
const ResumeRefusalSchema: Union<readonly [Struct<{ readonly kind: Literal<"finished">; }>, Struct<{ readonly kind: Literal<"blocked">; readonly blocker: Literals<readonly ["agentMissing", "pluginOff", "pluginUntrusted"]>; readonly name: String; }>, Struct<{ readonly kind: Literal<"unusableCheckpoint">; }>, Struct<{ readonly kind: Literal<"earlierBuild">; readonly cause: String; }>, Struct<{ readonly kind: Literal<"pluginUnavailable">; readonly plugin: String; readonly cause: String; }>, Struct<{ readonly kind: Literal<"notResumable">; }>]>
```

## RetryApprovalDecision

```ts
type RetryApprovalDecision =
  | 'present'
  | {
      readonly deny: 'yolo-retry' | 'credential' | 'policy' | 'unpresentable';
    };
```

## RetryPermission

```ts
type RetryPermission = typeof RetryPermissionSchema.Type;
```

## rollupOf

What `children` and their descendants count toward a parent's `rollup`:
the view's count over the run tree (each child's own `rollup` below it),
and the dispatch card's over the tree it lists (`below` recurses through
the children it lists instead). A child waiting between turns (held) or
paused, nothing asked of the user, has delivered its turn: it counts as
finished, not running.

```ts
function rollupOf(
  children: readonly ReadRunView[],
  below = (child: ReadRunView) => child.rollup,
): ReadRunView['rollup']
```

## RUN_OUTCOME

Canonical terminal outcome of an agent run — the single fact "how did this
run end", decided exactly once at the run-lifecycle boundary. Current
production writers use these values for terminal run, group-end, and run
state.

`cancelled` is a sibling of `failed`, never folded into it — a user stop is
not an error. This is the triad `ResultEvent.outcome` carries.

```ts
const RUN_OUTCOME: { readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }
```

## RunAction

```ts
type RunAction = typeof RunActionSchema.Type;
```

## runActionRefusal

Why a run no longer takes `action`: the refusal every handler words.

```ts
function runActionRefusal(
  run: Pick<ReadonlyRunView, 'holder' | 'label'>,
  action: RunAction,
): string
```

## runBypasses

Every kind's bypass for one run, as surfaces show it.

```ts
function runBypasses<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
): Readonly<Record<ApprovalBypassKind, boolean>>
```

## RunEndOutput

```ts
type RunEndOutput = typeof RunEndOutputSchema.Type;
```

## RunEndSchema

A run's terminal result as every reader sees it. `error` is present only
on a failed outcome; `usage` once a round recorded usage, including on
failures. Cost is `usage.cost` and nothing else. Derived on read
(`readRunEnd`): the usage is the run history's fold of its priced response
rows, the output as {@link RunEndOutputSchema} says.

```ts
const RunEndSchema: Struct<{ readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly error: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["disk-full", "result-lost", "unexpected"]>; readonly message: String; }>, Struct<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly kind: Literal<"model">; }>]>>; readonly usage: optional<Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>>; readonly output: Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; }>
```

## RunId

```ts
type RunId = typeof RunIdSchema.Type;
```

## RunIdentity

```ts
type RunIdentity = typeof RunIdentitySchema.Type;
```

## runIdentityDisplayName

UI label for a run identity — strips a known source prefix from agent ids.

```ts
function runIdentityDisplayName(id: RunIdentity): string
```

## runIdentityName

The identity's display name — what a listing row or tab label leads with.

```ts
function runIdentityName(id: RunIdentity): string
```

## RunIdSchema

The one id a run has: minted once at launch, assigned
at `run.start`, and the key of every fact about that run. Hex: 12 chars
when generated, 24 when derived from a checkpoint identity. Branded so a
string that was never minted as a run id cannot be passed for one.

```ts
const RunIdSchema: brand<String, "RunId">
```

## RunOutcome

```ts
type RunOutcome = typeof RunOutcomeSchema.Type;
```

## RunOutcomeSchema

```ts
const RunOutcomeSchema: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>
```

## RunPosition

```ts
type RunPosition = typeof RunPositionSchema.Type;
```

## RunRecord

The canonical run configuration (`RunRecordFieldsSchema`, the `run.config`
row's field): a real `AgentConfig` for agent runs, the honest minimal
record for everything else. The union keeps the strict non-agent arm
first: the agent arm's decoding defaults would fabricate an agent config
out of any object.

```ts
type RunRecord = typeof RunRecordFieldsSchema.Type;
```

## RunRecordFieldsSchema

Inputs have already passed launch validation; persisted records are canonical.

```ts
const RunRecordFieldsSchema: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>
```

## RunResult

One run's result as `readResult` answers it.

```ts
type RunResult = typeof RunResultSchema.Type;
```

## RunResultSchema

One run's result as `readResult` answers it: its terminal fact, the
terminal fields absent while the run has not ended, and a process run's
exit once its command exited.

```ts
const RunResultSchema: Struct<{ readonly error: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["disk-full", "result-lost", "unexpected"]>; readonly message: String; }>, Struct<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly kind: Literal<"model">; }>]>>; readonly usage: optional<Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>>; readonly output: Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; readonly outcome: optional<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>; readonly exit: optional<Struct<{ readonly code: NullOr<Int>; readonly timedOut: Boolean; }>>; }>
```

## RunStorageFileLocation

```ts
type RunStorageFileLocation =
  (typeof RunStorageFileLocationSchema)['Type'];
```

## runStorageFilePath

Reference to a run-storage file the way an agent prompt addresses it:
`/executions/<runId>/files/<relativePath>`. The one definition of that
convention.

```ts
function runStorageFilePath(
  runId: string,
  relativePath: string,
): string
```

## RuntimeRequest

One request a surface issues to its session's runtime.

```ts
type RuntimeRequest = typeof RuntimeRequestSchema.Type;
```

## RuntimeRequestSchema

Every request a surface issues to its session's runtime, one arm per
`group.action` tag.

```ts
const RuntimeRequestSchema: Union<readonly [Struct<{ readonly reason: Literals<readonly ["user", "shutdown"]>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.stop">; }>, Struct<{ readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.delete">; }>, Struct<{ readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.compact">; }>, Struct<{ readonly title: Trim; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.rename">; }>, Struct<{ readonly at: optional<NullOr<Int>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.fork">; }>, Struct<{ readonly model: String; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.model">; }>, Struct<{ readonly files: Union<readonly [Struct<{ readonly op: Literal<"copy">; readonly to: String; }>, Struct<{ readonly op: Literal<"remove">; }>]>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.files">; }>, Struct<{ readonly id: optional<NullOr<String>>; readonly text: String; readonly displayText: optional<NullOr<String>>; readonly media: optional<NullOr<$Array<Union<readonly [String, Struct<{ readonly mimeType: String; readonly digest: String; readonly name: String; }>]>>>>; readonly holdUntil: optional<NullOr<Literal<"turn">>>; readonly apiKeys: optional<$Record<String, String>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"followUp.send">; }>, Struct<{ readonly id: String; readonly wait: optional<NullOr<Boolean>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"followUp.receipt">; }>, Struct<{ readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; readonly grant: optional<NullOr<Literals<readonly ["bash", "toolEdit", "superYolo"]>>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"request.decide">; }>, Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly kind: Literal<"request.preview">; }>, Struct<{ readonly kind: Literal<"policy.set">; readonly change: Union<readonly [Struct<{ readonly bypass: Literals<readonly ["bash", "toolEdit", "superYolo"]>; readonly enabled: Boolean; readonly runId: brand<String, "RunId">; readonly field: Literal<"bypass">; }>, Struct<{ readonly limit: Literals<readonly ["never", "ask"]>; readonly runId: brand<String, "RunId">; readonly field: Literal<"limit">; }>]>; }>]>
```

## RunView

One stream of the {@link SessionView}.

```ts
type RunView = ReadonlyDeep<
  (typeof SessionViewSchema.Type)['runs'] extends ReadonlyMap<
    unknown,
    infer Run
  >
    ? Run
    : never
>;
```

## RunWorkspaceFile

A workspace file a run edited, as it stands now.

```ts
type RunWorkspaceFile = typeof RunWorkspaceFileSchema.Type;
```

## RunWorkspaceFileSchema

A workspace file a run edited, as it stands now.

```ts
const RunWorkspaceFileSchema: Struct<{ readonly path: String; readonly size: Int; readonly isDirectory: Boolean; }>
```

## ScriptDeliverySummary

```ts
type ScriptDeliverySummary = typeof ScriptDeliverySummarySchema.Type;
```

## serializeFilteredConfig

Serialize a run record to pretty JSON, dropping agent-config fields
irrelevant to the resolved display category so the serialized config the
orchestrator reads stays relevant. Records without an agent execution mode
are honest by construction and serialize unchanged.

```ts
function serializeFilteredConfig(
  record: RunRecord,
  category: string | undefined,
): string
```

## sessionActivity

The project-level activity every title and status pill shows, read from the
view and nothing else: a request this window can answer outranks a run
working right now; a conversation waiting on its user is idle.

```ts
function sessionActivity(view: ReadSessionView): SessionTitleState
```

## SessionEvent

```ts
type SessionEvent = typeof SessionEventSchema.Type;
```

## SessionEventDraft

What a publisher hands `SessionEvents.publish`: the body plus the aggregate
it lives on. The publisher stamps the rest of the envelope
(`seq`, `commit`, `origin`, `at`) under its permit; no caller passes them.
Parsing a draft removes caller-supplied envelope fields before storage.

```ts
type SessionEventDraft = typeof SessionEventDraftSchema.Type;
```

## SessionStoreMovedAside

What opening a store moved aside, whole (never read again): a store written
before 1.0, or a file SQLite reports damaged or not a database. Null when
nothing was moved. The one fact a host presents about it.

```ts
interface SessionStoreMovedAside {
  readonly path: string;
  readonly aside: string;
  readonly reason: 'pre-1.0' | 'corrupt';
}
```

## SessionTitleState

How busy a session reads in a title: idle, running, or awaiting approval.

```ts
type SessionTitleState = 'idle' | 'running' | 'approval';
```

## SessionView

One published level of the session's fold: an immutable value.

```ts
type SessionView = ReadonlyDeep<typeof SessionViewSchema.Type>;
```

## SessionViewSchema

One session's view at one moment: its runs, requests and grants.

```ts
const SessionViewSchema: Struct<{ readonly key: String; readonly runs: $ReadonlyMap<brand<String, "RunId">, Struct<{ readonly id: brand<String, "RunId">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly label: String; readonly description: NullOr<String>; readonly descriptionBy: NullOr<Literals<readonly ["model", "user"]>>; readonly title: String; readonly model: NullOr<String>; readonly modelLabel: NullOr<String>; readonly command: NullOr<String>; readonly inputFiles: $Array<String>; readonly agentScope: optional<NullOr<$Array<String>>>; readonly facts: $Record<String, Codec<Json, Json, never, never>>; readonly worktree: NullOr<Struct<{ readonly workingDirectory: String; }>>; readonly position: Literals<readonly ["ready", "running", "waiting"]>; readonly outcome: NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>; readonly holder: Literals<readonly ["here", "none"]>; readonly output: NullOr<Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>>; readonly statusNotice: NullOr<Union<readonly [Struct<{ readonly kind: Literals<readonly ["damaged", "earlierBuild"]>; }>, Struct<{ readonly kind: Literal<"lost">; readonly message: String; }>]>>; readonly lost: NullOr<String>; readonly createdAt: Int; readonly launchedAt: Int; readonly turnStartedAt: NullOr<Int>; readonly runStartedAt: NullOr<Int>; readonly lastTimestamp: Number; readonly turn: NullOr<Int>; readonly takesFollowUps: Boolean; readonly context: NullOr<Struct<{ readonly inputTokens: Int; readonly contextWindow: Int; readonly utilizationPercent: Number; }>>; readonly parentId: NullOr<brand<String, "RunId">>; readonly launchParentId: NullOr<brand<String, "RunId">>; readonly forkedFrom: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly at: Int; }>>; readonly forkPoint: NullOr<Int>; readonly parentCard: NullOr<String>; readonly ancestors: $Array<Struct<{ readonly id: brand<String, "RunId">; readonly label: String; }>>; readonly childIds: $Array<brand<String, "RunId">>; readonly rollup: Struct<{ readonly total: Int; readonly running: Int; readonly finished: Int; }>; readonly approval: Literals<readonly ["none", "own", "descendant"]>; readonly actions: $Array<Literals<readonly ["stop", "grant", "compact", "resume", "runAgain", "fork", "files", "delete", "rename", "openRunStorage", "export", "copy"]>>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly treeUsage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly thinkingActive: Boolean; readonly compactingActive: Boolean; readonly latestLine: NullOr<String>; readonly transcript: Struct<{ readonly rows: $Array<declare<TranscriptRow, TranscriptRow>>; readonly taskGroups: $Array<Struct<{ readonly id: String; readonly name: String; readonly startTime: Number; readonly endTime: optional<Number>; readonly status: Union<readonly [Literal<"running">, Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>]>; readonly parentGroupId: optional<String>; readonly kind: optional<Literals<readonly ["run", "session", "script"]>>; }>>; readonly settledRows: Int; }>; readonly recipe: NullOr<String>; }>>; readonly order: $Array<brand<String, "RunId">>; readonly cursor: Int; readonly debug: Boolean; readonly transcriptSeq: $ReadonlyMap<brand<String, "AggregateId">, Int>; readonly rollup: Struct<{ readonly running: Int; readonly waiting: Int; readonly interrupted: Int; }>; readonly requests: $Array<Struct<{ readonly runId: brand<String, "RunId">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; readonly content: String; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly errorDetails: Struct<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; }>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly model: String; readonly instruction: String; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly allowBypass: Boolean; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>, Struct<{ readonly kind: Literal<"plugin">; readonly plugin: String; readonly blocksCaller: Boolean; readonly answers: $Array<Literals<readonly ["approve", "approve_and_goal", "submit", "answer", "skip", "retry"]>>; readonly data: StructWithRest<Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; }>, readonly [$Record<String, Codec<Json, Json, never, never>>]>; }>]>; }>>; readonly policy: $ReadonlyMap<brand<String, "RunId">, Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>; readonly pluginFacts: $Array<Struct<{ readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly plugin: String; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly version: Int; readonly value: Codec<Json, Json, never, never>; readonly aggregateId: brand<String, "AggregateId">; }>>; readonly queuedFollowUps: $ReadonlyMap<brand<String, "RunId">, $Array<Struct<{ readonly followUpId: String; readonly text: String; }>>>; }>
```

## settingsCatalog

The harness's rows, then `rows` (an app's own, its plugins' included),
stored under `namespace`. A key declared twice is a defect and throws, and
so does a `defaults` key that names no harness row.

```ts
function settingsCatalog(options: {
  readonly namespace: string;
  readonly rows: readonly StateSettingEntry[];
  /** The app's own defaults for harness rows, by key: the value an absent
   *  key reads as (the helper model, which the harness leaves unset). */
  readonly defaults?: Readonly<Record<string, unknown>>;
}): SettingsCatalog
```

## SettingsCatalog

One settings catalog: its rows and the lookups the stores read from them.

```ts
interface SettingsCatalog {
  /** The app's prefix on every stored key (`texra`): the config and state
   *  stores write a row's relative key as `<namespace>.<key>`. */
  readonly namespace: string;
  /** Every row, in catalog order. */
  readonly rows: readonly StateSettingEntry[];
  /** Look up any row, config-file-backed or state-backed, by its key. */
  readonly byKey: (key: string) => StateSettingEntry | undefined;
  /** Look up a row by its stored key, as a store lists it. */
  readonly byStoredKey: (storedKey: string) => StateSettingEntry | undefined;
  /**
   * A fresh copy of a config-file-backed row's default, or `undefined` for a
   * key no such row owns: what every `ConfigProvider` answers for an absent
   * key. Parsed defaults are memoized
   * because this is on the read path of every absent setting; object values
   * are cloned so a caller cannot mutate the catalog's own default.
   */
  readonly configDefault: (key: string) => unknown;
}
```

## SettingStore

Storage slot a setting is read from / written to. `repoState` is shared by
every checkout of one git repository (keyed by its root in the global
database), so a repository has one value on every host and in every
worktree.

```ts
type SettingStore =
  | 'config'
  | 'workspaceState'
  | 'repoState'
  | 'globalState';
```

## SkillDisplayIssue

```ts
type SkillDisplayIssue = typeof SkillDisplayIssueSchema.Type;
```

## SkillDisplayIssueSchema

Discovery problem safe to carry to settings UIs.

```ts
const SkillDisplayIssueSchema: Struct<{ readonly message: String; readonly path: optional<String>; }>
```

## SkillDisplayItem

```ts
type SkillDisplayItem = typeof SkillDisplayItemSchema.Type;
```

## SkillDisplayItemSchema

One discovered skill projected for host settings displays.

```ts
const SkillDisplayItemSchema: Struct<{ readonly name: String; readonly description: String; readonly scope: Literals<readonly ["bundled", "user", "project", "interop", "custom"]>; readonly label: String; readonly path: String; readonly sourcePath: String; readonly enabled: Boolean; }>
```

## SkillNameSchema

Canonical grammar for discovered and persisted skill names.

```ts
const SkillNameSchema: decodeTo<String, String, never, never>
```

## splitContentLines

Normalize line endings and split into content lines.
A trailing newline does not produce a phantom empty element.

- `@example` splitContentLines('a\nb\nc')   // ['a', 'b', 'c']
  splitContentLines('a\nb\nc\n') // ['a', 'b', 'c']
  splitContentLines('')          // []

```ts
function splitContentLines(text: string): string[]
```

## StartRequestSchema

A start as data: all of `StartInput` but the run's own tools. Either an
agent (a name from the agent directories, or a persona written inline,
which the run stores so a resume needs no file) and the instruction to
give it, or `config`, a complete configuration an application host has
already resolved. A host sends it to a service as it is.

```ts
const StartRequestSchema: Union<readonly [Struct<{ readonly runId: optional<brand<String, "RunId">>; readonly continues: optional<brand<String, "RunId">>; readonly helperModel: optional<Boolean>; readonly approval: optional<Struct<{ readonly policy: optional<Literals<readonly ["never", "ask", "yolo"]>>; readonly delegated: optional<Boolean>; }>>; readonly interactive: optional<Boolean>; readonly apiKeys: optional<$Record<String, String>>; readonly agent: Union<readonly [String, toEncoded<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>]>; readonly instruction: String; readonly model: optional<String>; }>, Struct<{ readonly runId: optional<brand<String, "RunId">>; readonly continues: optional<brand<String, "RunId">>; readonly helperModel: optional<Boolean>; readonly approval: optional<Struct<{ readonly policy: optional<Literals<readonly ["never", "ask", "yolo"]>>; readonly delegated: optional<Boolean>; }>>; readonly interactive: optional<Boolean>; readonly apiKeys: optional<$Record<String, String>>; readonly config: Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>; }>]>
```

## StateSettingEntry

```ts
interface StateSettingEntry {
  /** The row's key, relative to its catalog's namespace (`memory.enabled`),
   *  which the stores add (`<namespace>.memory.enabled`). */
  readonly key: string;
  /**
   * The row's schema, carrying both validation and the decoding default
   * applied when the key is absent: decoding `undefined` yields that default.
   */
  readonly schema: Schema.Codec<unknown, unknown>;
  /** Short label for compact settings UIs; falls back to the stripped key. */
  readonly title?: string;
  /** Human-readable description, shared across every host that renders it. */
  readonly description?: string;
  /** Grouping label for settings UIs. Required once a UI renders the row. */
  readonly category?: string;
  /** Where the value is stored, the same on every host. */
  readonly slot: SettingStore;
  /** Config-backed target, workspace when omitted; `global`/`local` skip the project file. */
  readonly configTarget?: 'global' | 'workspace' | 'local';
  /**
   * A `global` row a project file may still switch off: its project value
   * counts unless it is `true`, so a repository can opt out (telemetry) but
   * never opt in. A malformed project value counts too, and fails closed.
   */
  readonly projectMayOptOut?: true;
  /**
   * Per-value descriptions for an enum setting, aligned 1:1 with the schema's
   * enum options (a host's settings UI derives them). The option *values* are
   * derived from the schema, not restated here.
   */
  readonly enumDescriptions?: readonly string[];
  /** Display labels for enum options, aligned 1:1 with the schema options. */
  readonly enumLabels?: readonly string[];
}
```

## StoredMedia

One attached media item by address ({@link StoredMediaSchema}).

```ts
type StoredMedia = typeof StoredMediaSchema.Type;
```

## StoredMediaSchema

Media a message attached, as a follow-up and its transcript row name
it: the file name it was attached under, and its bytes by address, as
a media part holds them, so the rows never point at a file that may be
gone.

```ts
const StoredMediaSchema: Struct<{ readonly mimeType: String; readonly digest: String; readonly name: String; }>
```

## stricterPolicy

The stricter of two policies (`never` < `ask` < `yolo`).

```ts
function stricterPolicy(
  a: ApprovalPolicy,
  b: ApprovalPolicy,
): ApprovalPolicy
```

## stripControlCharacters

Replace every C0/C1 control character (tab and newline included) with
`replacement`, so untrusted text cannot inject terminal escapes.

```ts
function stripControlCharacters(text: string, replacement = ''): string
```

## SUBSCRIPTION_AUTH_PROVIDERS

The subscription providers, as a settings view signs in and out of them:
the one spelling of a provider id everywhere. What a person calls each
subscription and its sign-in is an app's copy; the harness's own failure
text names a subscription by the provider it bills.

```ts
const SUBSCRIPTION_AUTH_PROVIDERS: readonly ["chatgpt", "grok"]
```

## SubscriptionAuthProvider

```ts
type SubscriptionAuthProvider =
  (typeof SUBSCRIPTION_AUTH_PROVIDERS)[number];
```

## sumUsageStats

Accumulates usage stats from an iterable into a single total. The route
and plan are kept when every nonempty item names the same one.

```ts
function sumUsageStats(
  items: Iterable<TokenUsageStats>,
): TokenUsageStats
```

## TaskGroup

```ts
type TaskGroup = typeof TaskGroupSchema.Type;
```

## TaskGroupStatus

```ts
type TaskGroupStatus = typeof TaskGroupStatusSchema.Type;
```

## toErrorMessage

Normalize any thrown value into a user-friendly error message string: the
error's own message, then the messages down its `cause` chain (and an
`AggregateError`'s members), each once, joined with `: `. A wrapper
whose sentence already embeds its cause's message adds nothing, and a
wrapper with a fixed sentence no longer hides the failure under it.

```ts
function toErrorMessage(err: unknown): string
```

## toJsonValue

A value as a stored row keeps it: what `JSON.stringify` writes, read
back. The boundary where an arbitrary value enters a persisted field.

```ts
const toJsonValue: (value: unknown) => Json
```

## TokenUsageStats

```ts
type TokenUsageStats = typeof TokenUsageStatsSchema.Type;
```

## TOOL_CALL_STATUS

The one status of a tool call: carried by `tool.end`, folded onto the
card, and read by every renderer. A failed call is `failed`; there is no
side-channel error flag beside it.

```ts
const TOOL_CALL_STATUS: { readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }
```

## ToolCallStatus

```ts
type ToolCallStatus = typeof ToolCallStatusSchema.Type;
```

## ToolCard

A card a tool states itself (`ToolCardSchema`).

```ts
type ToolCard = typeof ToolCardSchema.Type;
```

## ToolDefinition

Tool definition type - derived from schema

```ts
type ToolDefinition = typeof ToolDefinitionSchema.Type;
```

## ToolEditContent

A pending tool edit's content.

```ts
type ToolEditContent = typeof ToolEditContentSchema.Type;
```

## ToolEditPermission

```ts
type ToolEditPermission = typeof ToolEditPermissionSchema.Type;
```

## ToolFact

A fact a tool's call states about its run (`ToolFactSchema`).

```ts
type ToolFact = typeof ToolFactSchema.Type;
```

## ToolUseLog

```ts
type ToolUseLog = typeof ToolUseLogSchema.Type;
```

## TraceDocument

```ts
type TraceDocument = Readonly<typeof TraceDocumentSchema.Type>;
```

## TraceDocumentSchema

One finished run as a static viewer replays it: the run aggregate's own
display events in commit order, the same rows the live plane delivers to a
subscriber. Nothing is projected on the way out and nothing is
reconstructed on the way in.

The export authors four facts rather than copying them (`assembleTrace`):
no owner, no parent, no checkpoint and no follow-ups taken, because an
exported file has no producer, no siblings and no writable host.

```ts
const TraceDocumentSchema: Struct<{ readonly runId: brand<String, "RunId">; readonly events: $Array<Union<readonly [Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.start">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly takesFollowUps: Boolean; readonly worktree: optional<NullOr<Struct<{ readonly workingDirectory: String; }>>>; readonly parent: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; readonly call: NullOr<Struct<{ readonly callId: String; readonly card: String; readonly awaited: Boolean; }>>; }>>; readonly provenance: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"fork">; readonly from: Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; }>; readonly at: Int; }>]>>; readonly approvalPolicy: optional<NullOr<Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.removed">; readonly runIds: $Array<brand<String, "RunId">>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly plugin: String; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly version: Int; readonly value: Codec<Json, Json, never, never>; readonly aggregateId: brand<String, "AggregateId">; readonly unavailable: optional<String>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.activate">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.config">; readonly config: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>; readonly binding: optional<NullOr<Struct<{ readonly backend: Literals<readonly ["validation", "openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta"]>; readonly declinedRoutes: $Array<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>>; }>>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.detach">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.stop">; readonly reason: Literals<readonly ["user", "shutdown"]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.end">; readonly error: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["disk-full", "result-lost", "unexpected"]>; readonly message: String; }>, Struct<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly kind: Literal<"model">; }>]>>; readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly output: Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.description">; readonly description: String; readonly by: Literals<readonly ["model", "user"]>; readonly usage: optional<Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; readonly responseTimeMs: Number; readonly provider: String; }>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.queued">; readonly content: Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly media: optional<$Array<Struct<{ readonly mimeType: String; readonly digest: String; readonly name: String; }>>>; readonly from: Union<readonly [Struct<{ readonly kind: Literal<"user">; }>, Struct<{ readonly kind: Literal<"run">; readonly runId: brand<String, "RunId">; readonly relation: Literals<readonly ["parent", "child", "ancestor", "descendant", "sibling", "peer"]>; }>, Struct<{ readonly kind: Literal<"notification">; readonly source: Literal<"github">; }>]>; }>; readonly holdUntil: optional<Literals<readonly ["instruction", "turn"]>>; readonly control: optional<Union<readonly [Struct<{ readonly kind: Literal<"compact">; }>, Struct<{ readonly kind: Literal<"model">; readonly model: String; }>]>>; readonly followUpId: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.consumed">; readonly followUpId: String; readonly disposition: Union<readonly [Struct<{ readonly kind: Literal<"turn">; readonly turn: Int; }>, Struct<{ readonly kind: Literal<"answered">; }>, Struct<{ readonly kind: Literal<"applied">; }>, Struct<{ readonly kind: Literal<"dropped">; readonly reason: Literals<readonly ["noop", "ended", "closed"]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.opened">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; readonly content: String; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly errorDetails: Struct<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; }>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly model: String; readonly instruction: String; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly allowBypass: Boolean; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>, Struct<{ readonly kind: Literal<"plugin">; readonly plugin: String; readonly blocksCaller: Boolean; readonly answers: $Array<Literals<readonly ["approve", "approve_and_goal", "submit", "answer", "skip", "retry"]>>; readonly data: StructWithRest<Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; }>, readonly [$Record<String, Codec<Json, Json, never, never>>]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.decided">; readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"approval.policy">; readonly snapshot: Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.position">; readonly payload: Struct<{ readonly family: Literals<readonly ["toolUse"]>; readonly at: Literals<readonly ["turn.ready", "turn.begin", "turn.end", "response.ready", "results.ready", "waiting"]>; readonly turn: optional<NullOr<Int>>; readonly outcome: optional<NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"log">; readonly stageId: optional<String>; readonly level: Enum<{ readonly ERROR: "error"; readonly WARN: "warn"; readonly INFO: "info"; readonly DEBUG: "debug"; }>; readonly message: String; readonly data: optional<Codec<Json, Json, never, never>>; readonly messageType: optional<Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"process.output">; readonly stageId: optional<String>; readonly stream: Literals<readonly ["stdout", "stderr"]>; readonly text: String; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.start">; readonly stageId: optional<String>; readonly id: String; readonly label: String; readonly parentId: optional<NullOr<String>>; readonly kind: optional<NullOr<Literals<readonly ["run", "session", "script"]>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.end">; readonly stageId: optional<String>; readonly id: String; readonly status: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.start">; readonly stageId: optional<String>; readonly logId: String; readonly toolName: String; readonly input: Codec<Json, Json, never, never>; readonly phase: optional<String>; readonly attempt: optional<Int>; readonly card: optional<Struct<{ readonly title: String; readonly sections: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly label: String; readonly text: String; }>, Struct<{ readonly kind: Literal<"status">; readonly label: String; readonly status: String; }>, Struct<{ readonly kind: Literal<"identifier">; readonly label: String; readonly value: String; }>, Struct<{ readonly kind: Literal<"badges">; readonly label: String; readonly badges: $Array<String>; }>, Struct<{ readonly kind: Literal<"fileList">; readonly label: String; readonly files: $Array<Struct<{ readonly path: String; readonly note: optional<String>; }>>; }>]>>; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.end">; readonly stageId: optional<String>; readonly logId: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; readonly result: optional<Codec<Json, Json, never, never>>; readonly files: optional<$Array<Struct<{ readonly path: String; readonly ok: Boolean; readonly source: optional<String>; readonly sourceDisplay: optional<String>; readonly varName: optional<String>; readonly media: optional<Union<readonly [Struct<{ readonly kind: Literal<"image">; readonly mimeType: String; readonly sizeBytes: Int; }>, Struct<{ readonly kind: Literal<"audio">; readonly mimeType: String; readonly sizeBytes: Int; }>]>>; }>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"usage">; readonly stageId: optional<String>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"context.state">; readonly stageId: optional<String>; readonly inputTokens: Int; readonly contextWindow: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.start">; readonly stageId: optional<String>; readonly id: String; readonly kind: Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.end">; readonly stageId: optional<String>; readonly id: String; readonly finalText: optional<String>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"response.finalized">; readonly stageId: optional<String>; readonly text: String; readonly cut: optional<Literals<readonly ["length", "content-filter"]>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>]>>; }>
```

## TraceFactKind

A plugin row kind as an imported trace reads it: a `Plugin` fact kind.

```ts
interface TraceFactKind {
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: Schema.Codec<unknown, unknown>;
}
```

## TranscriptView

A stream's transcript slice: what hosts paint.

```ts
type TranscriptView = RunView['transcript'];
```

## truncateSummary

Collapse whitespace first, then truncate to a fixed-width one-line summary.

```ts
function truncateSummary(text: string, maxLength: number): string
```

## truncateWithEllipsis

Truncate a string to `maxLen` grapheme clusters with a trailing ellipsis (`…`).
Returns the original string unchanged if it fits within the limit.

Uses `Intl.Segmenter` so multi-codepoint graphemes (ZWJ emoji sequences like
👨‍👩‍👧, combining diacritics, …) are counted and cut as single units — no
split surrogates and no torn emoji.

- `@example` truncateWithEllipsis('short', 60)           // 'short'
  truncateWithEllipsis('a very long text', 10) // 'a very lo…'

```ts
function truncateWithEllipsis(text: string, maxLen: number): string
```

## UnreadableRun

```ts
type UnreadableRun = typeof UnreadableRunSchema.Type;
```

## UsageRoute

The route a request's usage is billed through.

```ts
type UsageRoute = typeof UsageRouteSchema.Type;
```

## UserQuestionAnswers

```ts
type UserQuestionAnswers = typeof UserQuestionAnswersSchema.Type;
```

## UserQuestionAnswersSchema

```ts
const UserQuestionAnswersSchema: $Record<String, Union<readonly [String, $Array<String>]>>
```

## UserQuestionPermission

```ts
type UserQuestionPermission =
  (typeof UserQuestionPermissionSchema)['Type'];
```

## UserQuestionPrompt

```ts
type UserQuestionPrompt = typeof UserQuestionPromptSchema.Type;
```

## UserQuestionPromptSchema

```ts
const UserQuestionPromptSchema: Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>
```

## WorkspaceAgentsSelection

```ts
type WorkspaceAgentsSelection =
  (typeof WorkspaceAgentsSelectionSchema)['Type'];
```

## WorkspaceFileLocation

```ts
type WorkspaceFileLocation = typeof WorkspaceFileLocationSchema.Type;
```

## WorkspaceStateKey

The harness's workspace-scoped state keys (`roots.workspaceState`).

```ts
const WorkspaceStateKey: Readonly<{ readonly WORKSPACE_AGENTS: "workspaceAgents"; readonly HIDDEN_CUSTOM_AGENTS: "hiddenCustomAgents"; readonly DISABLED_SKILLS: "skills.disabled"; readonly DISABLED_SKILL_SOURCES: "skills.disabledSources"; readonly GIT_MARK_COMMITS: "git.markCommits"; readonly GIT_AUTHOR_NAME: "git.authorName"; readonly GIT_AUTHOR_EMAIL: "git.authorEmail"; readonly GIT_WORKTREE_SUPPORT: "git.worktreeSupport"; readonly TOOL_PATH_PROTECTION_ENABLED: "tools.restrictPathsToWorkingDirectory"; }>
```

## WorktreeInfo

```ts
type WorktreeInfo = typeof WorktreeInfoSchema.Type;
```
