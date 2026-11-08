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
- **Commands & approvals**: [`RuntimeCommandSchema`](#runtimecommandschema)
  ([`RuntimeCommand`](#runtimecommand)), [`RequestDecision`](#requestdecision),
  [`OutcomeSchema`](#outcomeschema), [`RequestErrorSchema`](#requesterrorschema),
  [`ApprovalPolicySchema`](#approvalpolicyschema), [`resolveBypass`](#resolvebypass).
- **Agent definitions & run outcomes**: [`AgentConfigSchema`](#agentconfigschema),
  [`InlinePersonaSchema`](#inlinepersonaschema), [`RunEndSchema`](#runendschema),
  [`RunIdSchema`](#runidschema), [`StartRequestSchema`](#startrequestschema).
- **Settings & trace export**: [`settingsCatalog`](#settingscatalog),
  the harness's setting rows ([`SettingRow`](#settingrow), each a
  [`StateKey`](#statekey)), [`TraceDocumentSchema`](#tracedocumentschema).

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

## AGENT_SKILLS_ENABLED_SETTING

Whether agents receive the skills discovered from every source.

```ts
const AGENT_SKILLS_ENABLED_SETTING: { readonly key: "skills.enabled"; readonly slot: "config"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Enable skills for agents"; readonly description: "Expose enabled built-in and imported skills to agent prompts. Skills are off by default."; }
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

## AgentProposalRequest

```ts
type AgentProposalRequest = (typeof AgentProposalRequestSchema)['Type'];
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

## ALLOW_ORCHESTRATOR_KILL_SETTING

```ts
const ALLOW_ORCHESTRATOR_KILL_SETTING: { readonly key: "allowOrchestratorKill"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Let a task stop its agents"; readonly description: "Allow a task to stop the agents it started once they are no longer needed."; }
```

## APPROVAL_BYPASS_KINDS

```ts
const APPROVAL_BYPASS_KINDS: readonly ["bash", "toolEdit", "superYolo"]
```

## APPROVAL_POLICIES

```ts
const APPROVAL_POLICIES: readonly ["never", "ask", "yolo"]
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

## APPROVAL_POLICY_SETTING

The approval policy. Strict on purpose: `settingEnumOptions` derives the
dropdown from a literal-list row, and the tolerant spelling belongs to
`parseApprovalPolicy`, which every reader of typed-in text (the env var,
`--approval-policy`, `/approval`, the dropdown) calls before a value ever
reaches this row.

```ts
const APPROVAL_POLICY_SETTING: { readonly key: "approvalPolicy"; readonly slot: "config"; readonly schema: withDecodingDefault<Literals<readonly ["never", "ask", "yolo"]>, never>; readonly title: "Approval policy"; readonly description: "Whether agents ask before running shell commands and editing files."; readonly configTarget: "local"; readonly choices: { readonly never: { readonly label: "Block"; }; readonly ask: { readonly label: "Ask"; }; readonly yolo: { readonly label: "Auto-approve"; }; }; }
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

## BashRequest

```ts
type BashRequest = typeof BashRequestSchema.Type;
```

## blocksCaller

Whether a request blocks the tool that opened it: every kind the harness
opens does, and a plugin's request as it declares. One that does not
leaves its run working; its plugin's decision hook delivers the answer to
whichever process holds the run by then, so it stays open across every
resume. The folds and the decision door all read this one predicate.

```ts
const blocksCaller: (payload: { readonly kind: "toolEdit"; readonly data: { readonly requestId: string; readonly offersGrant: boolean; readonly runId: string & Brand<"RunId">; readonly path: string; readonly relativePath: string; readonly sourceTool: string; readonly addedLines: number; readonly removedLines: number; readonly content: string; }; } | { readonly kind: "bash"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly command: string; readonly cwd?: string | undefined; }; } | { readonly kind: "retry"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly operation: string; readonly errorDetails: { readonly message: string; readonly statusCode?: number | undefined; readonly statusText?: string | undefined; readonly provider?: string | undefined; readonly classification?: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; } | undefined; readonly requestId?: string | undefined; readonly partialText?: string | undefined; }; readonly model?: string | undefined; readonly credentialSwitch?: { readonly kind: "decline-route"; readonly route: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; readonly automatic: boolean; } | { readonly kind: "new-key"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | null | undefined; }; } | { readonly kind: "proposal"; readonly data: { readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly task: boolean; readonly script?: { readonly title: string | null; readonly source: string; readonly calls: readonly { readonly toolName: string; readonly preview: string; }[]; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly options?: { readonly [x: string]: Json; } | null | undefined; }; } | { readonly kind: "planApproval"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly plan: { readonly objective: string; }; }; } | { readonly kind: "userQuestion"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly questions: readonly { readonly options: readonly { readonly label: string; readonly description?: string | null | undefined; }[]; readonly question: string; readonly header?: string | null | undefined; readonly multiSelect?: boolean | null | undefined; readonly allowFreeText?: boolean | null | undefined; }[]; readonly context?: string | null | undefined; }; } | { readonly kind: "plugin"; readonly plugin: string; readonly blocksCaller: boolean; readonly answers: readonly ("retry" | "approve" | "approve_and_goal" | "submit" | "answer" | "skip")[]; readonly data: { readonly [x: string]: Json; readonly requestId: string; readonly runId: string & Brand<"RunId">; }; }) => boolean
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

## causeChain

`err` followed by its `cause` chain, outermost first; an
`AggregateError`'s `errors` follow it before its cause, and an error
whose `reason` carries the cause (a `PlatformError`, a `SqlError`) is
followed by that cause. Shared traversal for messages and for
predicates whose fact may sit at any depth of a wrapped error.

```ts
function causeChain(err: unknown): unknown[]
```

## CHATGPT_CODEX_CONTEXT_WINDOW_SETTING

The ChatGPT-subscription input budget; unset, each model takes the window
the Codex backend grants it.

The stored unit is **thousands of tokens**, and the key says so. Every
budget in play is a round multiple of 1000 (272K, 400K, 872K), so a raw
token count is three zeros nobody wants to type and an off-by-1000 typo
lands inside the valid range instead of being rejected: `872` entered for
872,000 is a legal 872-token budget that puts every request over the limit,
and the failure then names a number the user never meant to set.

```ts
const CHATGPT_CODEX_CONTEXT_WINDOW_SETTING: { readonly key: "chatgptCodex.contextWindowK"; readonly slot: "config"; readonly schema: withDecodingDefault<NullOr<Int>, never>; readonly title: "Subscription input token budget (K tokens)"; readonly description: "Input token budget for ChatGPT-subscription (Codex) routing, in thousands of tokens, mirroring Codex CLI's model_context_window. Unset, each model takes the window the Codex backend grants it; a value overrides it for every model, up to 872 (872,000 tokens). Automatic compaction may run earlier according to the separate compaction threshold. The model's output budget is added when displaying the total context window. The OpenAI backend enforces the real per-account limit — values above what your subscription allows fail and trigger compaction recovery."; }
```

## CHATGPT_PREFER_SUBSCRIPTION_SETTING

```ts
const CHATGPT_PREFER_SUBSCRIPTION_SETTING: { readonly key: "chatgptCodex.preferSubscription"; readonly slot: "config"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Prefer the ChatGPT subscription"; readonly description: "Prefer your signed-in ChatGPT subscription for Codex-eligible OpenAI models instead of API-key routing. Experimental. Subscription routing takes the input window the Codex backend grants each model; use chatgptCodex.contextWindowK to override it."; }
```

## CHILD_RUN_CONCURRENCY_BUDGET_SETTING

How many native child model conversations one session runs at once.

```ts
const CHILD_RUN_CONCURRENCY_BUDGET_SETTING: { readonly key: "childRunConcurrencyBudget"; readonly slot: "config"; readonly schema: withDecodingDefault<Int, never>; readonly title: "Agents at once"; readonly description: "Maximum number of agents one task may run at once in the background; a script's agent() calls also run at most this many at once. 0 (the default) sizes it to this machine's CPU count. Agents beyond the budget wait for a slot to free."; }
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

## Conflict

A `followUp.send` under an `id` the run holds another message under.

```ts
class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
  runId: RunIdSchema,
  id: Schema.String,
})
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

## DASHSCOPE_REGION_SETTING

```ts
const DASHSCOPE_REGION_SETTING: { readonly provider: "dashscope"; readonly key: "dashscope.useChina"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Qwen China region (Bailian)"; readonly description: "Use the China region endpoint instead of the international one. Display name switches to \"Bailian\"."; readonly slot: "globalState"; }
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

## DEBUG_MODE_SETTING

Transcript verbosity, its one meaning: the debug tier of the transcript
view and the detail of the payloads it shows. A log surface's own level
filter decides what that surface prints, so no producer reads this row to
widen or narrow a log; only a view build does.

```ts
const DEBUG_MODE_SETTING: { readonly key: "logger.debugMode"; readonly slot: "config"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Verbose transcript"; readonly description: "Show the transcript's verbose tier: debug-level rows and their payload detail. The log surfaces filter themselves (the Output view's own level filter, the desktop log file, the CLI's --verbose/--quiet)."; }
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

## DEFAULT_TASK_AGENT

Agent selected when launch input names none.

```ts
const DEFAULT_TASK_AGENT: "correct"
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

## DETACH_SUBAGENTS_ON_STOP_SETTING

```ts
const DETACH_SUBAGENTS_ON_STOP_SETTING: { readonly key: "detachSubagentsOnStop"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Keep agents running"; readonly description: "Let a task's agents continue when the task is stopped."; }
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

## DISABLED_SKILL_SOURCES_SETTING

```ts
const DISABLED_SKILL_SOURCES_SETTING: { readonly key: "skills.disabledSources"; readonly slot: "config"; readonly schema: withDecodingDefault<$Array<Literals<readonly ["bundled", "user", "project", "interop", "custom"]>>, never>; readonly title: "Skill sources"; readonly description: "Enable or disable skill source groups in this workspace."; }
```

## DISABLED_SKILLS_SETTING

```ts
const DISABLED_SKILLS_SETTING: { readonly key: "skills.disabled"; readonly slot: "config"; readonly schema: withDecodingDefault<$Array<String>, never>; readonly title: "Skills"; readonly description: "Enable or disable individual skills in this workspace."; }
```

## DispatchFacts

```ts
type DispatchFacts = typeof DispatchFactsSchema.Type;
```

## DisplayRow

```ts
type DisplayRow = typeof DisplayRowSchema.Type;
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

## factName

The name of the fact kind `plugin` declares as `kind`.

```ts
const factName: (fact: { readonly plugin: string; readonly kind: string; }) => string & Brand<"FactName">
```

## FactName

{@link FactNameSchema}'s value.

```ts
type FactName = typeof FactNameSchema.Type;
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

## formatCompactDuration

Compact duration capped at two units (`45s`, `3m 5s`, `1h 1m`).

Backed by `pretty-ms` with whole-second flooring,
but renders zero / negative / sub-second durations as `0s` (used by elapsed
displays that start from zero, e.g. goal timings and server uptime).

```ts
function formatCompactDuration(durationMs: number): string
```

## formatCompactTokenCount

Format token counts for compact usage displays.

Token displays intentionally stay raw until they exceed 4096, the common
small-context threshold where an abbreviated number starts buying space. Once
k-format rounding would print `1000k`, switch to `M` instead.

```ts
function formatCompactTokenCount(tokens: number): string
```

## formatCostUsd

Format a USD cost value as a display string with three decimal places.
e.g. `0.012` → `'$0.012'`

```ts
function formatCostUsd(cost: number): string
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

## formatResultCount

Format a result count with proper pluralization.
Example: formatResultCount(3, 'result') returns "3 results"

```ts
function formatResultCount(
  count: number,
  singular: string,
  plural?: string,
): string
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

## GIT_AUTHOR_EMAIL_SETTING

```ts
const GIT_AUTHOR_EMAIL_SETTING: { readonly key: "git.authorEmail"; readonly slot: "repoState"; readonly schema: withDecodingDefault<String, never>; readonly title: "Agent commit email"; readonly description: "Author and committer email used for agent-authored commits when commit marking is enabled."; }
```

## GIT_AUTHOR_NAME_SETTING

```ts
const GIT_AUTHOR_NAME_SETTING: { readonly key: "git.authorName"; readonly slot: "repoState"; readonly schema: withDecodingDefault<String, never>; readonly title: "Agent commit author"; readonly description: "Author and committer name used for agent-authored commits when commit marking is enabled."; }
```

## GIT_COMMITS_TO_SHOW_SETTING

The launcher's commit picker reads the count through the host snapshot on
both GUI hosts; the CLI only writes it, through the setup assistant's
`update_config`.

```ts
const GIT_COMMITS_TO_SHOW_SETTING: { readonly key: "git.numberOfCommitsToShow"; readonly slot: "config"; readonly schema: withDecodingDefault<Int, never>; readonly title: "Commits to show"; readonly description: "Number of recent commits to show in the commit selection dropdown"; }
```

## GIT_MARK_COMMITS_SETTING

```ts
const GIT_MARK_COMMITS_SETTING: { readonly key: "git.markCommits"; readonly slot: "repoState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Mark agent commits"; readonly description: "Attribute agent-authored git commits to the agent commit author so they are distinguishable from your own commits."; }
```

## GIT_WORKTREE_SUPPORT_SETTING

```ts
const GIT_WORKTREE_SUPPORT_SETTING: { readonly key: "git.worktreeSupport"; readonly slot: "repoState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Subagent worktrees"; readonly description: "Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict."; }
```

## GLM_CODING_PLAN_SETTING

```ts
const GLM_CODING_PLAN_SETTING: { readonly key: "glm.codingPlan"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "GLM Coding Plan"; readonly description: "Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits."; }
```

## GLM_ENDPOINT_SETTING

GLM's custom-endpoint row, which also decides whether the Coding Plan
route applies (`readModelSettings`).

```ts
const GLM_ENDPOINT_SETTING: { readonly id: "glm"; readonly key: "endpoint.glm"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }
```

## GLM_REGION_SETTING

```ts
const GLM_REGION_SETTING: { readonly provider: "glm"; readonly key: "glm.useChina"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "GLM China region"; readonly description: "Use the China region endpoint instead of the international one. Enabled by default. API keys work with either endpoint."; readonly slot: "globalState"; }
```

## GOAL_MAX_COST_SETTING

What a goal's rounds may spend before it pauses instead of starting another
round; `0` disables the cap. Read when the goal launches, into its script.
Global: a committed project config must not raise or remove the user's cap.

```ts
const GOAL_MAX_COST_SETTING: { readonly key: "goal.maxCostUsd"; readonly slot: "config"; readonly schema: withDecodingDefault<Number, never>; readonly configTarget: "global"; readonly title: "Goal spend cap (USD)"; readonly description: "Spend in US dollars, across its rounds, at which an autonomous goal pauses instead of starting another round. Raise it, then run the goal again to continue. Set to 0 to remove the cap (not recommended with auto-approve on your own API key)."; }
```

## GOAL_STRATEGY_SETTING

The script module whose `goal` export a plan run as a goal calls. The
default is the goal plugin's own module; a `scriptModules` entry of any
plugin that is on may replace it. Read when the goal launches. Global, as
the cap is: the strategy is what checks the cap, so a committed project
config must not pick one that ignores it.

```ts
const GOAL_STRATEGY_SETTING: { readonly key: "goal.strategy"; readonly slot: "config"; readonly schema: withDecodingDefault<String, never>; readonly configTarget: "global"; readonly title: "Goal strategy"; readonly description: "The script module a plan run as a goal runs, by its import specifier (`builtIn:<module>`): its `goal(objective, { maxCostUsd })` export decides the rounds, what context each starts from and when to stop, and resolves to the goal's result. Defaults to the goal plugin's own module."; }
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

## GOOGLE_BACKGROUND_RESPONSES_SETTING

```ts
const GOOGLE_BACKGROUND_RESPONSES_SETTING: { readonly key: "model.useGoogleBackgroundResponses"; readonly slot: "config"; readonly schema: withDecodingDefault<Boolean, never>; readonly configTarget: "global"; readonly title: "Google background responses"; readonly description: "Run text-only Google generations as background Interactions (submit + poll) instead of one long streamed request. Requires server-side conversation state and a model that supports background execution. Off by default; unsupported models fall back automatically."; }
```

## GOOGLE_INTERACTIONS_SERVER_STATE_SETTING

```ts
const GOOGLE_INTERACTIONS_SERVER_STATE_SETTING: { readonly key: "model.useGoogleInteractionsServerState"; readonly slot: "config"; readonly schema: withDecodingDefault<Boolean, never>; readonly configTarget: "global"; readonly title: "Server-side conversation state"; readonly description: "Store Interactions conversation state on Google's servers (send only the new turn each round; Google retains the conversation for a limited period to enable chaining). Disable to keep conversations off Google's servers and resend the full transcript each round."; }
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

## HarnessRowKey

The key of each of the harness's rows: what an app's table of where it
shows them is total over.

```ts
type HarnessRowKey = (typeof HARNESS_SETTINGS)[number]['key'];
```

## HELPER_MODEL_SETTING

No default here: absent means none is configured, and a helper call uses
the run's own model. An app names its own (`settingsCatalog`'s
`defaults`).

```ts
const HELPER_MODEL_SETTING: { readonly key: "helperModel"; readonly slot: "globalState"; readonly schema: UndefinedOr<String>; readonly title: "Helper model"; readonly description: "Model used for auxiliary tasks: instruction polishing, merges, and session descriptions. When unset, a run's helper calls use the run's own model."; }
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

## isEmptyUsage

Whether usage stats are all zeros (effectively empty).

```ts
function isEmptyUsage(usage: TokenUsageStats): boolean
```

## isInterrupted

Whether nobody drives the run although it has not ended: its process
stopped before it finished, and a resume continues it.

```ts
const isInterrupted: (run: Pick<{ readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly description: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly takesFollowUps: boolean; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly recipe: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly facts: { readonly [x: string & Brand<"FactName">]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly position: "waiting" | "ready" | "running"; readonly approval: "own" | "descendant" | "none"; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly holder: "here" | "none"; readonly statusNotice: { readonly kind: "earlierBuild" | "damaged"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly turnStartedAt: number | null; readonly runStartedAt: number | null; readonly parentId: (string & Brand<"RunId">) | null; readonly launchParentId: (string & Brand<"RunId">) | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly parentCard: string | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly latestLine: string | null; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly sectionCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly media?: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | TypeOptionalKeys<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly rawMessage: optional<String>; readonly operation: optional<String>; readonly model: optional<String>; }>; readonly value: string; }[]; readonly failure?: { readonly message: string; readonly classification: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; }; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: "in_progress" | "completed" | "failed"; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; }; readonly section?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly source?: string | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly quotaFallback?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly stages: readonly { readonly id: string; readonly name: string; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly seqNo: number; readonly startTime: number; readonly endTime?: number | undefined; }[]; readonly settledRows: number; }; readonly agentScope?: readonly string[] | null | undefined; }, "outcome" | "holder">) => boolean
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
const isUnreadable: (run: Pick<{ readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly description: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly takesFollowUps: boolean; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly recipe: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly facts: { readonly [x: string & Brand<"FactName">]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly position: "waiting" | "ready" | "running"; readonly approval: "own" | "descendant" | "none"; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly holder: "here" | "none"; readonly statusNotice: { readonly kind: "earlierBuild" | "damaged"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly turnStartedAt: number | null; readonly runStartedAt: number | null; readonly parentId: (string & Brand<"RunId">) | null; readonly launchParentId: (string & Brand<"RunId">) | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly parentCard: string | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly latestLine: string | null; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly sectionCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly media?: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | TypeOptionalKeys<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly rawMessage: optional<String>; readonly operation: optional<String>; readonly model: optional<String>; }>; readonly value: string; }[]; readonly failure?: { readonly message: string; readonly classification: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; }; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: "in_progress" | "completed" | "failed"; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; }; readonly section?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly source?: string | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly quotaFallback?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly stages: readonly { readonly id: string; readonly name: string; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly seqNo: number; readonly startTime: number; readonly endTime?: number | undefined; }[]; readonly settledRows: number; }; readonly agentScope?: readonly string[] | null | undefined; }, "statusNotice">) => boolean
```

## isWorking

Whether the run is working a turn in this process right now (a pending
approval or question is still the turn's).

```ts
const isWorking: (run: Pick<{ readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly description: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly takesFollowUps: boolean; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly recipe: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly facts: { readonly [x: string & Brand<"FactName">]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly position: "waiting" | "ready" | "running"; readonly approval: "own" | "descendant" | "none"; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly holder: "here" | "none"; readonly statusNotice: { readonly kind: "earlierBuild" | "damaged"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly turnStartedAt: number | null; readonly runStartedAt: number | null; readonly parentId: (string & Brand<"RunId">) | null; readonly launchParentId: (string & Brand<"RunId">) | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly parentCard: string | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly latestLine: string | null; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly sectionCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly media?: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | TypeOptionalKeys<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly rawMessage: optional<String>; readonly operation: optional<String>; readonly model: optional<String>; }>; readonly value: string; }[]; readonly failure?: { readonly message: string; readonly classification: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; }; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: "in_progress" | "completed" | "failed"; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; }; readonly section?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly source?: string | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly quotaFallback?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly stages: readonly { readonly id: string; readonly name: string; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly seqNo: number; readonly startTime: number; readonly endTime?: number | undefined; }[]; readonly settledRows: number; }; readonly agentScope?: readonly string[] | null | undefined; }, "position" | "holder">) => boolean
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

## KIMI_CODE_PREFER_SETTING

```ts
const KIMI_CODE_PREFER_SETTING: { readonly key: "kimiCode.prefer"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Kimi Code subscription"; readonly description: "Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform."; }
```

## LaunchApproval

```ts
type LaunchApproval = typeof LaunchApprovalSchema.Type;
```

## LaunchNotice

A refused launch's notice ({@link LaunchNoticeSchema}).

```ts
type LaunchNotice = typeof LaunchNoticeSchema.Type;
```

## LaunchNoticeSchema

The notice a refused launch carries for its caller to show
(`LaunchRefused.notice`), as the presentation event and payload a host's
`emit` takes: the instruction for a model the build does not recognize,
or the agent the launch named that the catalog does not hold. The launch
shows nothing itself; the caller shows this where it shows the failure.

```ts
const LaunchNoticeSchema: Union<readonly [Struct<{ readonly event: Literal<"requestShowInstruction">; readonly payload: Struct<{ readonly key: String; readonly message: String; readonly showSuppress: optional<Boolean>; }>; }>, Struct<{ readonly event: Literal<"agentNotFound">; readonly payload: Struct<{ readonly agentName: String; }>; }>]>
```

## launchPolicy

The policy a launch's privileged actions (commands, edits, delegated
work) are decided under: the project's, narrowed by the limit the launch
asks for, or Auto-approve, which widens its own task but never over
Block. Auto-approve gets there by turning the run's grants on
(`rootLaunch`), not by changing the run's policy, which stays the
project's: a question or a retry still goes to a person where one can
answer it.

```ts
function launchPolicy(
  project: ApprovalPolicy,
  approval: LaunchApproval | undefined,
): ApprovalPolicy
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
  event: Pick<SessionRowDraft, 'type'>,
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

## MAX_IMAGE_DIMENSION_SETTING

```ts
const MAX_IMAGE_DIMENSION_SETTING: { readonly key: "maxImageDimension"; readonly slot: "config"; readonly schema: withDecodingDefault<Int, never>; readonly title: "Maximum image size (px)"; readonly description: "Maximum dimension (width or height) in pixels for images before resizing. Images larger than this will be resized to fit within this dimension while maintaining aspect ratio."; }
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

## MEMORY_ENABLED_SETTING

Every host's runtime honors the row through the `memory` entry of the
memory-workflow plugin's `injectedWhen` (`@tools/plugins`).

```ts
const MEMORY_ENABLED_SETTING: { readonly key: "memory.enabled"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Enable memory for chat agents"; readonly description: "Remember useful details across chat sessions."; }
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

## MINIMAX_REGION_SETTING

```ts
const MINIMAX_REGION_SETTING: { readonly provider: "minimax"; readonly key: "minimax.useChina"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "MiniMax China region"; readonly description: "Use the China region endpoint instead of the international one. API keys are region-specific — you must obtain a key from the matching region."; readonly slot: "globalState"; }
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

The share of the model's context window that triggers automatic
compaction; `0` disables it. No `configTarget`: both runtime readers
resolve the merged config value through `Settings.get`, so narrowing the
row to the global scope would hide (and block writes to) a workspace
override the runtime honors.

```ts
const MODEL_COMPACTION_THRESHOLD_SETTING: { readonly key: "model.compactionThresholdPercent"; readonly slot: "config"; readonly schema: withDecodingDefault<Number, never>; readonly title: "Compaction threshold"; readonly description: "When the conversation reaches this percentage of the model's context limit, earlier messages are summarized automatically to free up space. Lower values trigger summarization sooner. Set to 0 to disable."; }
```

## MODEL_RETRY_MAX_ATTEMPTS_SETTING

The number of automatic retries after the initial model request.

```ts
const MODEL_RETRY_MAX_ATTEMPTS_SETTING: { readonly key: "model.retry.maxAttempts"; readonly slot: "config"; readonly schema: withDecodingDefault<Int, never>; readonly title: "Automatic retries"; readonly description: "Additional automatic retries after the initial model request (0–5). A resumed request keeps the retries it already used."; }
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

## MOONSHOT_REGION_SETTING

```ts
const MOONSHOT_REGION_SETTING: { readonly provider: "moonshot"; readonly key: "moonshot.useChina"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Kimi/Moonshot China region"; readonly description: "Use the China endpoint instead of the international one. Enabled by default. Keys are platform-specific: a key from one region does not work on the other."; readonly slot: "globalState"; }
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

## offeredGrant

The run grant `payload` offers: its kind's grant, or null when the opener
said only a person answers it (`offersGrant: false`: a hook asked, or a
command prompt for another tool's call, whose grant is not the shell's).
The one reading every surface renders "approve all in this task" from,
and every grant the run holds is checked against.

```ts
const offeredGrant: (payload: { readonly kind: "toolEdit"; readonly data: { readonly requestId: string; readonly offersGrant: boolean; readonly runId: string & Brand<"RunId">; readonly path: string; readonly relativePath: string; readonly sourceTool: string; readonly addedLines: number; readonly removedLines: number; readonly content: string; }; } | { readonly kind: "bash"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly command: string; readonly cwd?: string | undefined; }; } | { readonly kind: "retry"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly operation: string; readonly errorDetails: { readonly message: string; readonly statusCode?: number | undefined; readonly statusText?: string | undefined; readonly provider?: string | undefined; readonly classification?: { readonly kind: "missing-api-key" | "context-window" | "upstream-credit"; } | { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | { readonly kind: "subscription-session"; readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; readonly sessionError: string; } | undefined; readonly requestId?: string | undefined; readonly partialText?: string | undefined; }; readonly model?: string | undefined; readonly credentialSwitch?: { readonly kind: "decline-route"; readonly route: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; readonly automatic: boolean; } | { readonly kind: "new-key"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | null | undefined; }; } | { readonly kind: "proposal"; readonly data: { readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly task: boolean; readonly script?: { readonly title: string | null; readonly source: string; readonly calls: readonly { readonly toolName: string; readonly preview: string; }[]; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly options?: { readonly [x: string]: Json; } | null | undefined; }; } | { readonly kind: "planApproval"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly plan: { readonly objective: string; }; }; } | { readonly kind: "userQuestion"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly questions: readonly { readonly options: readonly { readonly label: string; readonly description?: string | null | undefined; }[]; readonly question: string; readonly header?: string | null | undefined; readonly multiSelect?: boolean | null | undefined; readonly allowFreeText?: boolean | null | undefined; }[]; readonly context?: string | null | undefined; }; } | { readonly kind: "plugin"; readonly plugin: string; readonly blocksCaller: boolean; readonly answers: readonly ("retry" | "approve" | "approve_and_goal" | "submit" | "answer" | "skip")[]; readonly data: { readonly [x: string]: Json; readonly requestId: string; readonly runId: string & Brand<"RunId">; }; }) => "bash" | "toolEdit" | "superYolo" | null
```

## OPENAI_FAST_TIER_SETTING

```ts
const OPENAI_FAST_TIER_SETTING: { readonly key: "model.openaiFastTier"; readonly slot: "config"; readonly schema: withDecodingDefault<Boolean, never>; readonly configTarget: "global"; readonly title: "Fast mode"; readonly description: "Send OpenAI requests on OpenAI's fast service tier, for models that offer it: faster responses at a higher per-token price, which run costs reflect."; }
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
const OutcomeSchema: Union<readonly [Struct<{ readonly kind: Literal<"done">; }>, Struct<{ readonly kind: Literal<"followUp">; readonly id: String; readonly status: Literals<readonly ["sent", "queued"]>; readonly receipt: Union<readonly [Struct<{ readonly state: Literal<"accepted">; }>, Struct<{ readonly state: Literal<"incorporated">; readonly turn: Int; }>, Struct<{ readonly state: Literal<"answered">; readonly turn: optional<Int>; readonly answer: Int; }>, Struct<{ readonly state: Literal<"unanswered">; readonly turn: optional<Int>; readonly reason: Union<readonly [Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>, Literals<readonly ["noop", "ended", "closed"]>]>; readonly error: optional<String>; }>]>; }>, Struct<{ readonly kind: Literal<"receipt">; readonly receipt: Union<readonly [Struct<{ readonly state: Literal<"accepted">; }>, Struct<{ readonly state: Literal<"incorporated">; readonly turn: Int; }>, Struct<{ readonly state: Literal<"answered">; readonly turn: optional<Int>; readonly answer: Int; }>, Struct<{ readonly state: Literal<"unanswered">; readonly turn: optional<Int>; readonly reason: Union<readonly [Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>, Literals<readonly ["noop", "ended", "closed"]>]>; readonly error: optional<String>; }>]>; }>, Struct<{ readonly kind: Literal<"forked">; readonly runId: brand<String, "RunId">; }>, Struct<{ readonly kind: Literal<"preview">; readonly preview: NullOr<Struct<{ readonly originalContent: String; readonly proposedContent: String; readonly hunks: $Array<Struct<{ readonly oldStart: Int; readonly oldLines: Int; readonly newStart: Int; readonly newLines: Int; readonly lines: $Array<String>; }>>; readonly firstChangedLine: NullOr<Int>; }>>; }>, Struct<{ readonly kind: Literal<"runFiles">; readonly result: Union<readonly [Struct<{ readonly status: Literal<"done">; readonly to: optional<String>; }>, Struct<{ readonly status: Literal<"noFiles">; }>, Struct<{ readonly status: Literal<"error">; readonly error: String; }>]>; }>]>
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

## Persona

A persona with its defaults applied: what a run is offered and told.

```ts
type Persona = typeof PersonaSchema.Type;
```

## Plan

```ts
type Plan = typeof PlanSchema.Type;
```

## PlanApprovalRequest

```ts
type PlanApprovalRequest = (typeof PlanApprovalRequestSchema)['Type'];
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

A request a plugin opens (`RequestPayload`'s plugin case).

```ts
type PluginRequest = typeof PluginRequestSchema.Type;
```

## pluralize

Return the singular or plural form of `singular` based on `count`.

```ts
function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string
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

## PROVIDER_ENDPOINT_SETTINGS

The providers' custom-endpoint rows, in catalog order.

```ts
const PROVIDER_ENDPOINT_SETTINGS: readonly [{ readonly id: "openai"; readonly key: "endpoint.openai"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "anthropic"; readonly key: "endpoint.anthropic"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "google"; readonly key: "endpoint.google"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "xai"; readonly key: "endpoint.xai"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "deepseek"; readonly key: "endpoint.deepseek"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "moonshot"; readonly key: "endpoint.moonshot"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "dashscope"; readonly key: "endpoint.dashscope"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "minimax"; readonly key: "endpoint.minimax"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "glm"; readonly key: "endpoint.glm"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }, { readonly id: "meta"; readonly key: "endpoint.meta"; readonly schema: withDecodingDefault<String, never>; readonly title: `${string} endpoint`; readonly description: `Custom base URL for ${string} API requests. Leave empty to use the default endpoint.`; readonly slot: "globalState"; }]
```

## providerEndpointSetting

A provider's custom-endpoint row, if it offers one.

```ts
function providerEndpointSetting(
  provider: string,
): (typeof PROVIDER_ENDPOINT_SETTINGS)[number] | undefined
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
  Extract<SessionRow, { type: 'followup.queued' }>,
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
function referencedAggregates(event: SessionRow): AggregateId[]
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

## replayInputs

A cold read as the view's inputs, in the reader's order: the debug
policy; the local snapshot, before the rows it describes (a run applied
before it reads as held by nothing, and the transcript rows an unheld run
finishes stay finished once it is known held); the listing; the
subscription set; the subscribed aggregates' rows; and the marker. The live
reader and an exported trace both answer a subscribe with it.

```ts
function replayInputs(read: {
  readonly debug: boolean;
  readonly local: LocalRuntimeState;
  readonly listing: readonly DisplayRow[];
  readonly subscriptions: readonly TranscriptSubscription[];
  readonly aggregateRows: readonly DisplayRow[];
  readonly existence: Extract<
    SessionViewInput,
    { _tag: 'replay.complete' }
  >['existence'];
}): SessionViewInput[]
```

## requestAnswerability

```ts
function requestAnswerability(
  run: ReadRunView,
  payload: RequestPayload,
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

How a runtime request fails: the classes themselves, which a wire
carries as they are. A bridge adds its own (a request it could not parse,
a handler that died) on its side.

```ts
const RequestErrorSchema: Union<readonly [typeof RunActive, typeof Unavailable, typeof Cancelled, typeof Rejected, typeof Conflict]>
```

## RequestKind

The one request kind vocabulary, read off the payload union. The
`request.opened` fact and every surface that lists pending requests key
off it, so a spelling that drifts fails to compile.

```ts
type RequestKind = RequestPayload['kind'];
```

## RequestPayload

A pending request's payload, as {@link RequestPayloadSchema} reads it.

```ts
type RequestPayload = typeof RequestPayloadSchema.Type;
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

## RetryRequest

```ts
type RetryRequest = typeof RetryRequestSchema.Type;
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
production writers use these values for terminal run, stage-end, and run
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

## RunActive

A launch here holds the run this request would act on.

```ts
class RunActive extends Schema.TaggedError<RunActive>()('RunActive', {
  runId: RunIdSchema,
})
```

## runBypasses

Every kind's bypass for one run, as surfaces show it.

```ts
function runBypasses<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
): Readonly<Record<ApprovalBypassKind, boolean>>
```

## RunChanged

A run's removal found a later lifetime of the run than the one its
request read (it ended and started again since); nothing was written.

```ts
class RunChanged extends Schema.TaggedError<RunChanged>()('RunChanged', {
  aggregateId: AggregateIdSchema,
})
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

## RunStanding

Where a run stands: its loop position, and its outcome once it ended
(`RunView` carries both).

```ts
interface RunStanding {
  readonly position: RunPosition;
  readonly outcome: RunOutcome | null;
}
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

## RuntimeCommand

One command a surface issues to its session's runtime.

```ts
type RuntimeCommand = typeof RuntimeCommandSchema.Type;
```

## RuntimeCommandSchema

Every command a surface issues to its session's runtime, one arm per
`group.action` tag.

```ts
const RuntimeCommandSchema: Union<readonly [Struct<{ readonly reason: Literals<readonly ["user", "released", "shutdown"]>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.stop">; }>, Struct<{ readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.delete">; }>, Struct<{ readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.compact">; }>, Struct<{ readonly title: Trim; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.rename">; }>, Struct<{ readonly at: optional<NullOr<Int>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.fork">; }>, Struct<{ readonly model: String; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.model">; }>, Struct<{ readonly files: Union<readonly [Struct<{ readonly op: Literal<"copy">; readonly to: String; }>, Struct<{ readonly op: Literal<"remove">; }>]>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.files">; }>, Struct<{ readonly id: optional<NullOr<String>>; readonly text: String; readonly displayText: optional<NullOr<String>>; readonly media: optional<NullOr<$Array<Union<readonly [String, Struct<{ readonly mimeType: String; readonly digest: String; readonly name: String; }>]>>>>; readonly holdUntil: optional<NullOr<Literal<"turn">>>; readonly apiKeys: optional<$Record<String, String>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"followUp.send">; }>, Struct<{ readonly id: String; readonly wait: optional<NullOr<Boolean>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"followUp.receipt">; }>, Struct<{ readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; readonly grant: optional<NullOr<Literals<readonly ["bash", "toolEdit", "superYolo"]>>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"request.decide">; }>, Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly kind: Literal<"request.preview">; }>, Struct<{ readonly kind: Literal<"policy.set">; readonly change: Union<readonly [Struct<{ readonly bypass: Literals<readonly ["bash", "toolEdit", "superYolo"]>; readonly enabled: Boolean; readonly runId: brand<String, "RunId">; readonly field: Literal<"bypass">; }>, Struct<{ readonly limit: Literals<readonly ["never", "ask"]>; readonly runId: brand<String, "RunId">; readonly field: Literal<"limit">; }>]>; }>]>
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

## SAVE_MODEL_IO_SETTING

```ts
const SAVE_MODEL_IO_SETTING: { readonly key: "debug.saveModelIO"; readonly slot: "config"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Save model requests and responses"; readonly description: "Save what is sent to and received from the model: the request messages and raw responses as JSON, plus the final input prompt as XML."; }
```

## SCRIPT_ONLY_SETTING

Code mode's "only" stage: every chat run gets `script`, and the model sees
no other tool; the rest are callable from scripts alone. The codemode
plugin's `injectedWhen` reads the row to inject `script`; the step reads it
to send the model `script` and the run's own tools alone, recorded per tool
on its `tools.offered` row.

```ts
const SCRIPT_ONLY_SETTING: { readonly key: "codeMode.scriptOnly"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Script-only tools"; readonly description: "Send chat agents the script tool and their own tools alone: every other tool is called from inside a script. Off by default while the comparison against direct tool calls runs."; }
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

## SessionRow

```ts
type SessionRow = typeof SessionRowSchema.Type;
```

## SessionRowDraft

What a publisher hands `SessionEvents.publish`: the body plus the aggregate
it lives on. The publisher stamps the rest of the envelope
(`seq`, `commit`, `origin`, `at`) under its permit; no caller passes them.
Parsing a draft removes caller-supplied envelope fields before storage.

```ts
type SessionRowDraft = typeof SessionRowDraftSchema.Type;
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
const SessionViewSchema: Struct<{ readonly key: String; readonly runs: $ReadonlyMap<brand<String, "RunId">, Struct<{ readonly id: brand<String, "RunId">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly label: String; readonly description: NullOr<String>; readonly descriptionBy: NullOr<Literals<readonly ["model", "user"]>>; readonly title: String; readonly model: NullOr<String>; readonly modelLabel: NullOr<String>; readonly command: NullOr<String>; readonly inputFiles: $Array<String>; readonly agentScope: optional<NullOr<$Array<String>>>; readonly facts: $Record<brand<String, "FactName">, Codec<Json, Json, never, never>>; readonly worktree: NullOr<Struct<{ readonly workingDirectory: String; }>>; readonly position: Literals<readonly ["ready", "running", "waiting"]>; readonly outcome: NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>; readonly holder: Literals<readonly ["here", "none"]>; readonly output: NullOr<Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>>; readonly statusNotice: NullOr<Union<readonly [Struct<{ readonly kind: Literals<readonly ["damaged", "earlierBuild"]>; }>, Struct<{ readonly kind: Literal<"lost">; readonly message: String; }>]>>; readonly lost: NullOr<String>; readonly createdAt: Int; readonly launchedAt: Int; readonly turnStartedAt: NullOr<Int>; readonly runStartedAt: NullOr<Int>; readonly lastTimestamp: Number; readonly turn: NullOr<Int>; readonly takesFollowUps: Boolean; readonly context: NullOr<Struct<{ readonly inputTokens: Int; readonly contextWindow: Int; readonly utilizationPercent: Number; }>>; readonly parentId: NullOr<brand<String, "RunId">>; readonly launchParentId: NullOr<brand<String, "RunId">>; readonly forkedFrom: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly at: Int; }>>; readonly forkPoint: NullOr<Int>; readonly parentCard: NullOr<String>; readonly ancestors: $Array<Struct<{ readonly id: brand<String, "RunId">; readonly label: String; }>>; readonly childIds: $Array<brand<String, "RunId">>; readonly rollup: Struct<{ readonly total: Int; readonly running: Int; readonly finished: Int; }>; readonly approval: Literals<readonly ["none", "own", "descendant"]>; readonly actions: $Array<Literals<readonly ["stop", "grant", "compact", "resume", "runAgain", "fork", "files", "delete", "rename", "openRunStorage", "export", "copy"]>>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly treeUsage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly thinkingActive: Boolean; readonly compactingActive: Boolean; readonly latestLine: NullOr<String>; readonly transcript: Struct<{ readonly rows: $Array<declare<TranscriptRow, TranscriptRow>>; readonly stages: $Array<Struct<{ readonly id: String; readonly name: String; readonly seqNo: Int; readonly startTime: Number; readonly endTime: optional<Number>; readonly outcome: NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>; }>>; readonly settledRows: Int; }>; readonly recipe: NullOr<String>; }>>; readonly order: $Array<brand<String, "RunId">>; readonly cursor: Int; readonly debug: Boolean; readonly transcriptSeq: $ReadonlyMap<brand<String, "AggregateId">, Int>; readonly rollup: Struct<{ readonly running: Int; readonly waiting: Int; readonly interrupted: Int; }>; readonly requests: $Array<Struct<{ readonly runId: brand<String, "RunId">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; readonly content: String; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly errorDetails: Struct<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; }>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly model: String; readonly instruction: String; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly workingDirectory: optional<NullOr<String>>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>, Struct<{ readonly kind: Literal<"plugin">; readonly plugin: String; readonly blocksCaller: Boolean; readonly answers: $Array<Literals<readonly ["approve", "approve_and_goal", "submit", "answer", "skip", "retry"]>>; readonly data: StructWithRest<Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; }>, readonly [$Record<String, Codec<Json, Json, never, never>>]>; }>]>; }>>; readonly policy: $ReadonlyMap<brand<String, "RunId">, Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>; readonly pluginFacts: $Array<Struct<{ readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly plugin: String; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly version: Int; readonly value: Codec<Json, Json, never, never>; readonly aggregateId: brand<String, "AggregateId">; }>>; readonly queuedFollowUps: $ReadonlyMap<brand<String, "RunId">, $Array<Struct<{ readonly followUpId: String; readonly text: String; }>>>; }>
```

## SettingChoiceCopy

How a settings UI shows one value of an enum setting.

```ts
interface SettingChoiceCopy {
  readonly label?: string;
  readonly description?: string;
}
```

## SettingRow

One setting, whose schema decodes its stored value to an `A`.

```ts
interface SettingRow<A = unknown> extends StateKey<A> {
  /** Short sentence-case label every settings UI shows for the row. */
  readonly title: string;
  /** Human-readable description, shared across every host that renders it. */
  readonly description: string;
  /** Config-backed target, workspace when omitted; `global`/`local` skip the project file. */
  readonly configTarget?: 'global' | 'workspace' | 'local';
  /**
   * A `global` row a project file may still switch off: its project value
   * counts unless it is `true`, so a repository can opt out (telemetry) but
   * never opt in. A malformed project value counts too, and fails closed.
   */
  readonly projectMayOptOut?: true;
  /**
   * Display copy for each value of an enum setting, keyed by the value, so
   * the record is total over the schema's values by type. The values
   * themselves are read off the schema, not restated here; a value without
   * a label shows as itself.
   */
  readonly choices?: { readonly [V in A & string]: SettingChoiceCopy };
}
```

## settingsCatalog

The harness's rows, then `rows` (an app's own, its plugins' included),
stored under `namespace`. A key declared twice is a defect and throws, and
so does a `defaults` key that names no harness row.

```ts
function settingsCatalog(options: {
  readonly namespace: string;
  readonly rows: readonly SettingRow[];
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
  readonly rows: readonly SettingRow[];
  /** Look up any row, config-file-backed or state-backed, by its key. */
  readonly byKey: (key: string) => SettingRow | undefined;
  /** Look up a row by its stored key, as a store lists it. */
  readonly byStoredKey: (storedKey: string) => SettingRow | undefined;
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

## SOX_PATH_SETTING

```ts
const SOX_PATH_SETTING: { readonly key: "audio.soxPath"; readonly slot: "config"; readonly schema: withDecodingDefault<String, never>; readonly title: "SoX path"; readonly description: "Path to the SoX executable. Overrides automatic detection."; }
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

## Stage

```ts
type Stage = typeof StageSchema.Type;
```

## StartRequestSchema

A start as data: all of `StartInput` but the run's own tools. Either an
agent (a name from the agent directories, or a persona written inline,
which the run stores so a resume needs no file) and the instruction to
give it, or `config`, a complete configuration an application host has
already resolved. A host sends it to a service as it is.

```ts
const StartRequestSchema: Union<readonly [Struct<{ readonly runId: optional<brand<String, "RunId">>; readonly continues: optional<brand<String, "RunId">>; readonly helperModel: optional<Boolean>; readonly approval: optional<Union<readonly [Literal<"autoApprove">, Literals<readonly ["never", "ask"]>]>>; readonly interactive: optional<Boolean>; readonly apiKeys: optional<$Record<String, String>>; readonly agent: Union<readonly [String, toEncoded<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>]>; readonly instruction: String; readonly model: optional<String>; }>, Struct<{ readonly runId: optional<brand<String, "RunId">>; readonly continues: optional<brand<String, "RunId">>; readonly helperModel: optional<Boolean>; readonly approval: optional<Union<readonly [Literal<"autoApprove">, Literals<readonly ["never", "ask"]>]>>; readonly interactive: optional<Boolean>; readonly apiKeys: optional<$Record<String, String>>; readonly config: Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>; }>]>
```

## StateKey

One stored key: where it lives and what its stored value decodes to. A
key that is not a setting (a stored record, a flag) is one of these beside
its owner, read with `Settings.state`; a setting row is one with copy.

```ts
interface StateKey<A = unknown> {
  /** The key, relative to its catalog's namespace (`memory.enabled`), which
   *  the stores add (`<namespace>.memory.enabled`). */
  readonly key: string;
  /** Where the value is stored, the same on every host. */
  readonly slot: SettingStore;
  /**
   * The schema, carrying validation, any bounds, and the decoding default
   * applied when the key is absent: decoding `undefined` yields that
   * default.
   */
  readonly schema: Schema.Codec<A, unknown>;
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

## stripControlCharacters

Replace every C0/C1 control character (tab and newline included) with
`replacement`, so untrusted text cannot inject terminal escapes.

```ts
function stripControlCharacters(text: string, replacement = ''): string
```

## SUBSCRIPTION_AUTH_PROVIDERS

```ts
const SUBSCRIPTION_AUTH_PROVIDERS: readonly ["chatgpt", "grok"]
```

## SUBSCRIPTION_ROUTES

The route each provider's session bills, which names its account
(`SubscriptionAccounts`). The ids stay as they are: the CLI's commands and
the settings views' messages spell them.

```ts
const SUBSCRIPTION_ROUTES: Readonly<{ chatgpt: "chatgpt-subscription"; grok: "xai-subscription"; }>
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

## TOOL_PATH_PROTECTION_SETTING

Keep file-oriented tools inside the active working directory unless the
user explicitly grants them access to arbitrary filesystem paths.

```ts
const TOOL_PATH_PROTECTION_SETTING: { readonly key: "tools.restrictPathsToWorkingDirectory"; readonly slot: "workspaceState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Restrict tool paths to the working directory"; readonly description: "Keep file-reading, editing, search, diagnostics, and PDF tools inside the active working directory. Turn this off only when an agent must use arbitrary filesystem paths."; }
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

## ToolDependencyStatus

```ts
type ToolDependencyStatus = typeof ToolDependencyStatusSchema.Type;
```

## ToolDependencyStatusSchema

Whether a tool plugin's external dependency is there, as the
availability probes find it (not a tool call's `ToolCallStatus`).

```ts
const ToolDependencyStatusSchema: Literals<readonly ["available", "not-found", "unknown"]>
```

## ToolEditContent

A pending tool edit's content.

```ts
type ToolEditContent = typeof ToolEditContentSchema.Type;
```

## ToolEditRequest

```ts
type ToolEditRequest = typeof ToolEditRequestSchema.Type;
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
const TraceDocumentSchema: Struct<{ readonly runId: brand<String, "RunId">; readonly events: $Array<Union<readonly [Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.start">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly takesFollowUps: Boolean; readonly worktree: optional<NullOr<Struct<{ readonly workingDirectory: String; }>>>; readonly parent: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; readonly call: NullOr<Struct<{ readonly callId: String; readonly card: String; readonly awaited: Boolean; }>>; }>>; readonly provenance: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"fork">; readonly from: Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; }>; readonly at: Int; }>]>>; readonly approvalPolicy: optional<NullOr<Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.removed">; readonly runIds: $Array<brand<String, "RunId">>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly plugin: String; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly version: Int; readonly value: Codec<Json, Json, never, never>; readonly aggregateId: brand<String, "AggregateId">; readonly unavailable: optional<String>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.activate">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.config">; readonly config: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>; readonly binding: optional<NullOr<Struct<{ readonly backend: Literals<readonly ["validation", "openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta"]>; readonly declinedRoutes: $Array<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>>; }>>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.detach">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.stop">; readonly reason: Literals<readonly ["user", "released", "shutdown"]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.end">; readonly error: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["disk-full", "result-lost", "unexpected"]>; readonly message: String; }>, Struct<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly kind: Literal<"model">; }>]>>; readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly output: Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.description">; readonly description: String; readonly by: Literals<readonly ["model", "user"]>; readonly usage: optional<Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; readonly responseTimeMs: Number; readonly provider: String; }>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.queued">; readonly content: Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly media: optional<$Array<Struct<{ readonly mimeType: String; readonly digest: String; readonly name: String; }>>>; readonly from: Union<readonly [Struct<{ readonly kind: Literal<"user">; }>, Struct<{ readonly kind: Literal<"run">; readonly runId: brand<String, "RunId">; readonly relation: Literals<readonly ["parent", "child", "ancestor", "descendant", "sibling", "peer"]>; }>, Struct<{ readonly kind: Literal<"notification">; readonly source: Literal<"github">; }>]>; }>; readonly holdUntil: optional<Literals<readonly ["instruction", "turn"]>>; readonly control: optional<Union<readonly [Struct<{ readonly kind: Literal<"compact">; }>, Struct<{ readonly kind: Literal<"model">; readonly model: String; }>]>>; readonly followUpId: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.consumed">; readonly followUpId: String; readonly disposition: Union<readonly [Struct<{ readonly kind: Literal<"turn">; readonly turn: Int; }>, Struct<{ readonly kind: Literal<"answered">; }>, Struct<{ readonly kind: Literal<"applied">; }>, Struct<{ readonly kind: Literal<"dropped">; readonly reason: Literals<readonly ["noop", "ended", "closed"]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.opened">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; readonly content: String; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly errorDetails: Struct<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["missing-api-key", "context-window", "upstream-credit"]>; }>, Struct<{ readonly kind: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>, Struct<{ readonly kind: Literal<"subscription-session">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; readonly sessionError: String; }>]>>; readonly requestId: optional<String>; readonly partialText: optional<String>; }>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly model: String; readonly instruction: String; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly workingDirectory: optional<NullOr<String>>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>, Struct<{ readonly kind: Literal<"plugin">; readonly plugin: String; readonly blocksCaller: Boolean; readonly answers: $Array<Literals<readonly ["approve", "approve_and_goal", "submit", "answer", "skip", "retry"]>>; readonly data: StructWithRest<Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; }>, readonly [$Record<String, Codec<Json, Json, never, never>>]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.decided">; readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"approval.policy">; readonly snapshot: Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.position">; readonly payload: Struct<{ readonly family: Literals<readonly ["toolUse"]>; readonly at: Literals<readonly ["turn.ready", "turn.begin", "turn.end", "response.ready", "results.ready", "waiting"]>; readonly turn: optional<NullOr<Int>>; readonly outcome: optional<NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"log">; readonly stageId: optional<String>; readonly level: Enum<{ readonly ERROR: "error"; readonly WARN: "warn"; readonly INFO: "info"; readonly DEBUG: "debug"; }>; readonly message: String; readonly data: optional<Codec<Json, Json, never, never>>; readonly messageType: optional<Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"process.output">; readonly stageId: optional<String>; readonly stream: Literals<readonly ["stdout", "stderr"]>; readonly text: String; readonly elided: optional<Int>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.start">; readonly stageId: optional<String>; readonly id: String; readonly label: String; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.end">; readonly stageId: optional<String>; readonly id: String; readonly status: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.start">; readonly stageId: optional<String>; readonly logId: String; readonly toolName: String; readonly input: Codec<Json, Json, never, never>; readonly section: optional<String>; readonly attempt: optional<Int>; readonly card: optional<Struct<{ readonly title: String; readonly sections: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly label: String; readonly text: String; }>, Struct<{ readonly kind: Literal<"status">; readonly label: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; }>, Struct<{ readonly kind: Literal<"identifier">; readonly label: String; readonly value: String; }>, Struct<{ readonly kind: Literal<"badges">; readonly label: String; readonly badges: $Array<String>; }>, Struct<{ readonly kind: Literal<"fileList">; readonly label: String; readonly files: $Array<Struct<{ readonly path: String; readonly note: optional<String>; }>>; }>]>>; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.end">; readonly stageId: optional<String>; readonly logId: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; readonly result: optional<Codec<Json, Json, never, never>>; readonly files: optional<$Array<Struct<{ readonly path: String; readonly ok: Boolean; readonly source: optional<String>; readonly sourceDisplay: optional<String>; readonly varName: optional<String>; readonly media: optional<Union<readonly [Struct<{ readonly kind: Literal<"image">; readonly mimeType: String; readonly sizeBytes: Int; }>, Struct<{ readonly kind: Literal<"audio">; readonly mimeType: String; readonly sizeBytes: Int; }>]>>; }>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"usage">; readonly stageId: optional<String>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"context.state">; readonly stageId: optional<String>; readonly inputTokens: Int; readonly contextWindow: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.start">; readonly stageId: optional<String>; readonly id: String; readonly kind: Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.end">; readonly stageId: optional<String>; readonly id: String; readonly finalText: optional<String>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"response.finalized">; readonly stageId: optional<String>; readonly text: String; readonly cut: optional<Literals<readonly ["length", "content-filter"]>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>]>>; }>
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

## Unavailable

The stream, request, or run the request names is gone or not in a state
that can take it.

```ts
class Unavailable extends Schema.TaggedError<Unavailable>()(
  'Unavailable',
  { runId: RunIdSchema, reason: Schema.String },
)
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

## UserQuestionPrompt

```ts
type UserQuestionPrompt = typeof UserQuestionPromptSchema.Type;
```

## UserQuestionPromptSchema

```ts
const UserQuestionPromptSchema: Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>
```

## UserQuestionRequest

```ts
type UserQuestionRequest = (typeof UserQuestionRequestSchema)['Type'];
```

## WEBSOCKET_OPENAI_SETTING

The OpenAI WebSocket transport (experimental).

```ts
const WEBSOCKET_OPENAI_SETTING: { readonly key: "websocket.openai"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "OpenAI WebSocket"; readonly description: "EXPERIMENTAL: use the persistent WebSocket transport for OpenAI Responses requests (lower latency for tool-use loops), and let the ChatGPT-subscription Codex backend attempt WebSocket. Off by default."; }
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

## WorktreeInfo

```ts
type WorktreeInfo = typeof WorktreeInfoSchema.Type;
```

## XAI_PREFER_SUBSCRIPTION_SETTING

```ts
const XAI_PREFER_SUBSCRIPTION_SETTING: { readonly key: "xaiGrok.preferSubscription"; readonly slot: "config"; readonly schema: withDecodingDefault<Boolean, never>; readonly title: "Prefer the Grok subscription"; readonly description: "Prefer your signed-in Grok (xAI SuperGrok) account for xAI models instead of API-key routing. Experimental. Uses the public Grok CLI OAuth client; xAI may change or revoke that registration without notice."; }
```
