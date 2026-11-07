# M. The harness's built-in tools, platform, utils and entries: design red flags

Area: `packages/harness/src/tools/`, `plugins.ts`, `skills/`, `platform/`,
`utils/`, `transcript/`, `logger/`, `common/`, `controllers/`, `host.ts`,
`node.ts`, `index.ts`. Read-only, on the working tree at `73e0225`
(after #14774, #14775, #14776). Paths below are relative to
`packages/harness/src` unless they start with `packages/`. Consumer counts
are over `packages/*/src`.

Round 1's E report owns the tool engine (`tools/core/*`, `tools/liveTools.ts`,
`tools/sessionTools.ts`, the executions `wait`); its findings are cited, not
repeated. `controllers/session/` is round 1's B area (R1, R7, R8); it gets a
short "what the roots still name" section at the end, no new findings.

Re-verified after the rebase: `ToolPolicy.oneShot` is a read (`noLaterTurn`,
`tools/bash.ts:327`, `tools/codemode/ScriptTool.ts:177`; #14774) and
`RouteUnavailable` carries no `reason` kind (`common/errors/agentErrors.ts:40-58`;
#14776). Neither is reported below.

## Numbers

Lines per directory (`.ts`): `tools/` 12,472 (60 files; `executions/` 942,
`memory/` 1,268, `codemode/` 1,052, `mcp/` 739, `web/` 531, `plan/` 402,
`approval/` 353, `core/` 234, top level 6,951), `controllers/session/` 6,453,
`common/` 4,505 (`plugins/` 3,337, `storage/` 700, `errors/` 389),
`utils/` 3,209 (`files/` 1,363, `system/` 1,052, `core/` 370, `text/` 250,
`errors/` 86), `platform/` 2,656 (`defaults/` 1,800), `skills/` 1,425,
`logger/` 537, `transcript/` 340; entries `plugins.ts` 235, `host.ts` 288,
`node.ts` 135, `index.ts` 131. Total 32,388 lines, 7,430 comment lines (23%).

Five largest files: `controllers/session/Database.ts` 946,
`tools/ExecutionsTool.ts` 773, `common/plugins/pluginManifest.ts` 566,
`tools/memory/MemoryTool.ts` 544, `utils/system/execUtils.ts` 510.

Comment share of the five worst files ≥ 200 lines (`^\s*(/\*|\*|//)` over
total): `platform/appSignals.ts` 60% (164/272: every signal's doc block is a
prose registry of which host consumes it), `utils/files/externalRoots.ts` 45%
(111/243: a security policy in prose), `tools/toolTable.ts` 40% (101/251: a
contract file; acceptable), `tools/plugins.ts` 36% (134/363: a contract
file), `platform/defaults/jsonStore.ts` 36% (109/299: `set`'s 25-line doc
explains the lane-then-apply protocol, finding 11). Next: `tools/pathResolution.ts`
30%, `tools/agentCatalogFollower.ts` 30%, `utils/files/fsDurability.ts` 30%,
`platform/defaults/nodePlatform.ts` 28%, `tools/toolAvailability.ts` 27%.

Primitives in the area (grep over the area; controllers in parentheses):
`*Unsafe(` 15 (8), `addObserver` 2 (0, `platform/processRuntime.ts:288`,
documented), `uninterruptibleMask` 1 (0, the spawner supervisor
`platform/defaults/nodePlatform.ts:238`), `Effect.uninterruptible` 9 (5),
`Effect.never` 2 (0: `tools/ExecutionsTool.ts:118`,
`platform/defaults/fileSecrets.ts:172`), `Deferred.make` 7 (2), `while (true)`
1 (`tools/toolAvailability.ts:201`), module-level `let` 7 (0), module-level
`Map`/`LRUCache`/`Set` of state 11, `Effect.ignore` 8 (2), `catchCause` 15
(5), `Effect.try` 24, `Effect.tryPromise` 10, `catch {` 4. The root-designs
note's acceptance criterion counts `*Unsafe`/`addObserver`/`uninterruptibleMask`:
this area holds 18 of them. Of the 7 outside controllers, 2 are the refuted
`withPerKeyLane` (`utils/core/perKeyQueue.ts:69,86`), 2 are `PubSub.publishUnsafe`
/ `Queue.offerUnsafe` on a synchronous listener edge
(`platform/appSignals.ts:194`, `tools/toolAvailability.ts:263`, finding 1),
and 3 are `SubscriptionRef.getUnsafe` snapshot reads
(`tools/ExecutionsTool.ts:118,380`, `tools/plan/PlanTool.ts:123`, findings 4
and "found").

---

## Finding 1. `toolAvailability` hand-rolls a latest-wins scheduler, a refcount and a signal relay where one `SubscriptionRef` per root and one stream would do

**Red flags:** reinvented Effect primitive (a lane map with an `again` flag,
a `Semaphore(1)` claim, an uninterruptible fork, a refcount map, a `Queue` fed
from a synchronous listener behind a readiness `Deferred`); a one-caller
option on a shared surface; comments substituting for design (27%).

**Evidence.** `tools/toolAvailability.ts`:

- `ProbeRound { inputs; again: boolean }` (`:123-126`), `lanes`
  (`:156-159`), `probeUntilSettled`'s `while (true)` that re-runs the probe
  when `again` was set (`:199-224`), and `start` (`:230-252`), which under
  `claim` (`Semaphore.make(1)`, `:168`) either mutates the running round's
  inputs and flag or forks a new fiber into the layer scope, the whole thing
  `Effect.uninterruptible` "so an interrupt cannot land between the fork and
  the lane that records it" (`:228-229`). This is "the newest inputs win and
  a late finisher cannot overwrite them", which is `SubscriptionRef.set`
  followed by `SubscriptionRef.changes` under `Stream.switchMap` (a new input
  interrupts the probe in flight instead of letting a stale one finish and
  then running again).
- `held: Map<root, ToolProbeInputs[]>` (`:164`), pushed and spliced by
  `hold`'s `acquireRelease` (`:286-305`) so results are kept while any session
  holds the root: a refcount by hand. `RcMap` keyed by workspace root, whose
  entry is the root's `SubscriptionRef<inputs>` plus its probe fiber, is the
  primitive; `RcMap.get` in the session's scope is the hold, and the entry's
  release drops the results.
- The credential relay: `Queue.unbounded` (`:257`), a `Deferred subscribed`
  (`:258`) handed to `onAppSignal` (`:259-267`), `Deferred.await` (`:268`),
  then a forever loop draining the queue (`:269-279`). `appSignalStream`
  (`platform/appSignals.ts:229-238`) already is that stream;
  `appSignalStream('credentialChanged').pipe(Stream.filter(k => REPROBE_SECRETS.has(k)), Stream.runForEach(...))`
  is the whole relay. The `subscribed?: Deferred` parameter of `onAppSignal`
  (`platform/appSignals.ts:251,256`) exists for this one caller (5 callers of
  `onAppSignal` repo-wide; 1 passes it).
- Consumers of the service: `hold` 1 (`controllers/session/sessionOwners.ts:300`),
  `refresh` 3 (`packages/extension/src/extension.ts:517`,
  `packages/desktop/src/main/desktopProjectBindings.ts:310`,
  `packages/texra/src/controllers/settingsView/ToolDashboardData.ts:146`),
  `results` 2 (`agent/runtime/agentToolResolution.ts:134`, the dashboard).

**The design decision behind it.** "Each root's latest probe result" was
built as a fiber-per-root scheduler with its own admission rule, instead of as
a per-root value that changes.

**The better design.** `RcMap.make({ lookup })` in the layer scope, keyed by
workspace root, where the looked-up resource is
`{ inputs: SubscriptionRef<ToolProbeInputs>; results: SubscriptionRef<ProbeResults | null> }`
plus one fiber forked in the entry's scope:
`SubscriptionRef.changes(inputs).pipe(Stream.switchMap((i) => Stream.fromEffect(probeRound(i))), Stream.runForEach((r) => SubscriptionRef.set(results, r)))`.
`Stream.switchMap` (4.0.0+) interrupts the previous inner stream when a new
element arrives, which is the "latest inputs win" rule `ProbeRound.again`
spells by hand. `hold(roots)` is `RcMap.get` in the session's scope then
`SubscriptionRef.set(inputs, roots)`; `refresh(inputs)` is the same set then
`SubscriptionRef.changes(results).pipe(Stream.drop(1), Stream.runHead)`;
the published `results` is the `RcMap.keys` joined with each entry's
`results`. The credential relay is
`appSignalStream('credentialChanged').pipe(Stream.filter(...), Stream.runForEach(...))`
over the live entries, forked once in the layer scope. Deleted: `ProbeRound`, `lanes`, `held`, `claim`,
`probeUntilSettled`, `start`'s fork-and-record, the `Queue` and `subscribed`
Deferred, and `onAppSignal`'s third parameter (1 caller). About 90 of the
file's 351 lines.

**What we give up.** A probe that was already running when new inputs arrive
is interrupted and restarted rather than finished and re-run; under the
20-second group deadline (`:68`) that is the cheaper behaviour, and nothing
reads a stale finish today either.

**Change amplification.** "A second trigger that re-probes" (a plugin switch
flip): today a new `Queue.offerUnsafe` site and listener, or a second queue:
2 edits in this file plus a signal; after: one more stream merged into the
relay: 1.

**Depends on:** none.

---

## Finding 2. The MCP server pool caches a failed start as a successful `RcMap` value and keeps a second `Set` to remember which values are failures

**Red flags:** error handling that should be defined out of existence; a
sentinel in a success (`failure?: string` on `LoadedPluginTools`); two
representations of "this entry failed"; special-case retry policy as data.

**Evidence.** `acquireMcpServer` turns a start failure into a success value
`{ tools: new Map(), failure }` (`tools/mcp/mcpServer.ts:386-392`), so the
`RcMap` in `projectServers` (`tools/mcp/mcpConfig.ts:302-309`, with
`idleTimeToLive: SERVER_IDLE`) keeps the failed entry like a live one. Because
the map now cannot tell, `holdServer` records the key in a `failed: Set<ServerKey>`
(`:313,318`) and `hold` walks that set on a root run, re-checks each entry's
`failure` and `RcMap.invalidate`s it (`:324-331`). `LoadedPluginTools.failure?`
(`:117`) is the optional field that carries the state through `HeldServer`,
`sessionTools.pinStep`'s `failures` (`tools/sessionTools.ts:227-229`) and
`HeldPlugins.loaded` (`tools/sessionTools.ts:298-301`). The comment at
`tools/sessionTools.ts:10`, "a failed or interrupted build is dropped", is
false for failures: in Effect 4.1.2 an `RcMap` entry whose lookup failed stays
in the map with its failure on the entry's `Deferred`, and every later `get`
or `getOption` "fails with the same error" (`node_modules/effect/src/RcMap.ts:590-595,617`);
only an interrupted lookup is removed (`removeInterrupted`, `:761-775`). A
false comment is a bug (root `AGENTS.md`, "Plain names and comments").

**The design decision behind it.** "A start that failed stays failed until the
project's next root run, so one task waits on a dead start once" (`:21-22`)
was implemented by lying to the cache and keeping the truth beside it.

**The better design.** Let `acquireMcpServer` fail with `McpStartError`: the
`RcMap` then holds the failure itself (verified above), so the map is the one
record of "this key failed" and `failed: Set` goes. The "wait on a dead start
once per task" rule, if kept, is one loop in `hold` at a root run over
`RcMap.keys` with `Effect.result(RcMap.getOption(servers, key))` and
`RcMap.invalidate` on a failure: no second set, since the map answers which
keys failed. If the rule is dropped, `holdServer` invalidates the key on its
own failure and every step retries, bounded by `START_TIMEOUT`. The step that
held the key reports the warning from the failure (the text already built at
`mcpServer.ts:390`). `RcMap` stays the pool: its release is counted per
borrower's scope (`RcMap.ts:783-800`), which a step mid-call needs;
`ScopedCache.makeWith`'s exit-dependent `timeToLive`
(`dist/ScopedCache.d.ts:117-122`) would expire a server by time while a step
still holds it, so it is not the primitive here. Deleted: `failed`,
`LoadedPluginTools.failure?`, `HeldServer`'s optional, `loaded`'s
`string | undefined` map in `HeldPlugins` (the warning list already carries
the reason), and the false comment at `sessionTools.ts:10`. `root: boolean`
stays only if the once-per-task rule stays (two callers,
`agent/runtime/run/AgentRun.ts:272`, `tools/sessionTools.ts:298`).

**What we give up.** With the rule dropped, a subagent of a task whose server
failed at the root's start re-tries the start (bounded by 30 s) instead of
reading the root's cached failure; with the rule kept, nothing.

**Change amplification.** "A server whose start should be retried on a
schedule": today the `failed` set, `hold`'s loop and the success-shaped
failure: 3 places; after: `Effect.retry({ schedule })` on the lookup: 1.

**Depends on:** none.

---

## Finding 3. "What a child process may see of the environment" is decided in four modules with two credential vocabularies and two environment bases

**Red flags:** information leakage (the set of secret-bearing variable names
known as a list in one place and a regex in another); two representations of
"the process environment" (`process.env` versus `environment`, which lays the
project's `.env` over it).

**Evidence.**

- `inheritedEnv` (`utils/system/envFlags.ts:78-98`) starts from `environment`
  (`:81`, the project's `.env` over `process.env`,
  `utils/system/nodeWorkspace.ts:71`) and withholds `API_KEY_ENV_NAMES`
  minus one `keep` plus `TEXRA_APPROVAL_POLICY` (`:88-89`): every shell
  command and agent CLI starts from it (`execUtils.ts:488`, 3 app callers).
- `serverEnv` (`tools/mcp/mcpServer.ts:131-143`) starts from `environment`
  too but withholds by the regex `/KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL/i`
  (`:64`), a second spelling of "a credential-shaped name" that neither
  includes nor is included by `API_KEY_ENV_NAMES` (a key named
  `OPENROUTER_AUTH` passes the regex; `TEXRA_APPROVAL_POLICY` passes it).
- `makeMachineGitEnv` (`utils/system/gitEnv.ts:45-53`) starts from
  `process.env` (`:48`), not `environment`, so a project's `.env` proxy or
  `GIT_SSH_COMMAND` never reaches a plugin's git fetch, while it does reach
  the same project's shell commands; it withholds a third list,
  `GIT_UNSAFE_ENV_KEYS` (`:12`).
- `runHook` (`common/plugins/pluginHooks.ts:282-290`) starts from nothing and
  allows `PATH`, `HOME` and the `CLAUDE_*` places; `PATH` is `process.env.PATH`
  (`:284`), again not the project's.

Four spawn sites, four policies, two of them deciding "credential" by
different rules, and two of them reading a different base. The hook's
minimal environment is a documented policy (`2026-09-28-code-plugins-hooks-v1.md`)
and stays; the other three are one policy with three spellings.

**The design decision behind it.** Each spawner scrubbed what it was worried
about at the time, in its own module, instead of one owner answering "the
environment a child of this kind starts from".

**The better design.** One `childEnvironment` in `utils/system/` over
`environment`, with the withheld set computed from one vocabulary:
`API_KEY_ENV_NAMES` (what the harness reads as its own credential) plus the
harness's own control variables (`TEXRA_APPROVAL_POLICY`), and the git helper
keys when the child is git. `serverEnv` becomes `childEnvironment` plus the
entry's `env` on top; `makeMachineGitEnv` becomes `childEnvironment({ git: true })`
with `GIT_TERMINAL_PROMPT=0`; `inheritedEnv(keep)` is the same call with a
`keep`. `SENSITIVE_ENV_NAME` is deleted (1 reader). The project's `.env`
reaches every child the same way.

**What we give up.** The MCP regex withholds more than the list does (a user's
unrelated `FOO_TOKEN` never reaches a third-party server); keeping that
breadth means the one vocabulary is "the list, plus names matching the
regex", stated once.

**Change amplification.** "A new credential variable the harness reads"
(a provider key): today `API_KEY_ENV_NAMES` in llm and a check that the regex
happens to match it: 2 sites, one by luck; after: 1.

**Depends on:** none.

---

## Finding 4. The plan tool recovers "which goal this conversation launched" by decoding its own past tool results, and re-encodes a boolean answer as a two-literal mode

**Red flags:** two representations of one fact (a goal's run id lives in a
`plan` result's `value` and is found by scanning results and matching call
ids); a derived predicate (`stillRunning`) walking the view; a boolean
re-encoded as a literal mode and mapped back through a table; a
`SubscriptionRef.getUnsafe` snapshot beside a durable read.

**Evidence.** `runPlanAsGoal` (`tools/plan/PlanTool.ts:96-186`): to refuse a
second goal it loads the run's calls (`:118`), reads every `tool.result` row
(`:119-122`), snapshots the live view (`:123`) and the registry (`:124`),
then for each result decodes `value` as `LaunchedSchema` (`:54,139`), keeps
it only when the issuing call's `toolName === 'plan'` (`:146`), and walks the
view's `childIds` recursively (`:127-132`) to decide whether that goal "still
holds the conversation". The goal plugin already owns a fact kind
(`factKinds: [GOAL_PLAN_KIND]`, `tools/builtinPlugins.ts:91`) and writes the
approved plan as a fact (`approvedPlan`, `:81-86`); the launched goal's run id
is not on it. Beside this, `armed: 'commands' | 'allAgentWork'` (`:99`) is
derived from `result.autoApproveAll ? 'allAgentWork' : 'commands'` (`:229`)
and immediately mapped back through `GOAL_AUTO_APPROVALS` (`:61-67`): a
boolean that became a mode so a table could turn it into a list. The run's
one-shot/script test at `:104-105` is E4's eight-site pattern (found).
`call.run.callbacks.onProgress?.({ kind: 'plan', ... })` (`:239,293`) is one
of five readers of an optional callback bag on the run; its other readers are
the loop's (`agent/runtime/loop/toolUse.ts:191,261,501`).

Open PR 14773: this tool launches through `tools/codemode/backgroundScript.ts`
(`launchBackgroundScript`, `:166`) and reads `config.script`, which that
proposal redesigns; sequence after it.

**The design decision behind it.** The goal's launch was recorded only as the
tool result the model read, so the next decision that needs it has to parse
model-facing output.

**The better design.** The plan fact carries the goal: `approvedPlan` is
written with `{ objective, goalRunId }` (or the plugin writes a second
`goal/launched` fact on its own aggregate), and `runPlanAsGoal` reads
`facts` once, then asks the view whether that one run has ended
(`durableOutcome`, no recursion: a goal that ended while its round's child
runs on is the child's problem, delivered to the conversation as every
child's end is). `LaunchedSchema`, the results scan, `issued`, `stillRunning`
and the `Runs` snapshot go. `GOAL_AUTO_APPROVALS` becomes
`autoApproveAll ? ALL_AGENT_WORK : COMMANDS`, two constants, no mode type.

**What we give up.** The "a goal that ended still holds the conversation while
a round's background agent runs" rule (`:125-132`); a second goal may then
start while a previous goal's detached child still runs, which the child's
delivery already explains.

**Change amplification.** "A second tool that launches a goal-like script and
must refuse a duplicate": today it re-implements the results scan: 1 file
copied; after: it reads the same fact: 0 new logic.

**Depends on:** none (R7 landed; the fact write is the plugin's own row).

---

## Finding 5. Which `/executions` paths a run kind serves is spelled three times: a route table, a per-category switch, and each handler's own refusal

**Red flags:** two (three) representations of one fact; a declarative table
(`EXECUTION_ROUTES`) missing the column that two other tables carry; change
amplification.

**Evidence.**

- `EXECUTION_ROUTES` (`tools/ExecutionsTool.ts:174-285`) lists every path with
  its summary and actions; it does not say which run kinds a path applies to,
  so the summaries say it in prose ("workflows only", `:259`; "stdout/stderr
  of a background command", `:250-251`).
- `getAvailablePaths` (`tools/executionFormatters.ts:40-62`) is the kind→paths
  table written as a `switch` over `RunDisplayCategory` with a
  `satisfies never`, rendered into the summary's "Available paths" line
  (`buildSummaryTailLines`, `:152-168`).
- Each handler then refuses a kind on its own: `showOutput` tests
  `run.identity.kind !== 'process'` and words its own message
  (`tools/executions/processOutput.ts:124-128`); `showConversation` refuses
  `view_range` with its own text (`ExecutionsTool.ts:228-233`);
  `HIDDEN_CONFIG_FIELDS_BY_CATEGORY` (`tools/executions/configView.ts:13-17`)
  is a third per-category table keyed by the same strings. `runDisplayCategory`
  (`executionFormatters.ts:21-25`) is read at `ExecutionsTool.ts:438,537`.

**The design decision behind it.** The route table was given the facts a
dispatcher needs (path, actions) and not the fact the summary and the
handlers also need (which kinds), so the latter grew two more homes.

**The better design.** One column on `EXECUTION_ROUTES`, `kinds: readonly RunDisplayCategory[]`
(or `'any'`). The dispatcher refuses a path a kind does not serve with one
generated message ("`/output` is served for process runs, not agent runs"),
so `processOutput.ts:124-128` and the `view_range` refusal go; the summary's
"Available paths" is `EXECUTION_ROUTES.filter(r => r.kinds.includes(category))`,
so `getAvailablePaths` goes; the config filter's per-category sets stay as the
one thing that is not a path. Deleted: `getAvailablePaths` (1 caller), the
`hasChildren` parameter threaded through `buildSummaryTailLines` for the
`children` pseudo-path (the summary already prints the children lines above
it), two handler refusals.

**What we give up.** The handler-specific wording of a refusal.

**Change amplification.** "A fifth run kind" (or a new path): today
`EXECUTION_ROUTES`, `getAvailablePaths` (compiler-enforced), the handler's
refusal and `HIDDEN_CONFIG_FIELDS_BY_CATEGORY`: 4 files; after: the route row
and, if it hides config fields, the filter: 2.

**Depends on:** none.

---

## Finding 6. The background shell keeps an in-memory head/tail capture beside the `process.output` rows it writes, with a whitespace option that is constant per caller

**Red flags:** two representations of one fact (the command's output: rows
and a capture); an option that is a decision the code refused to make
(`normalizeWhitespace`, `true` for the foreground call and `false` for the
background call); state in optional fields (`BashDeliveryStreamExcerpt.head?`,
`elidedChars?`).

**Evidence.** R5 landed `process.output` rows (`tools/bash.ts:257`
`logger.output(stream, chunk)`; `shared/toolUse.ts:170-176`;
`tools/executions/processOutput.ts:55-103` projects them) and named the
next step: "the in-memory head/tail capture goes: the delivery excerpt is
projected from the rows" (`2026-11-05-root-designs-effect-native.md`, R5
Design). The capture stayed: `createBoundedOutputCapture` (`tools/bash.ts:77-164`,
88 lines of head/tail/pending-whitespace bookkeeping), built twice per
background turn (`:235-243`) with `{ normalizeWhitespace: false }` (`:234`)
and twice per foreground call with the default `true` (`:347-354`), fed in
the same `onStdout` that writes the row (`:270-271`), and rendered by
`toDeliveryExcerpt` (`:173-187`) into `BashDeliveryStreamExcerpt` whose
`head?` and `elidedChars?` (`agent/runtime/delegation/bashDelivery.ts:32,38`)
are set exactly when the tail dropped text. The cap counters `recordedChars`/
`capReached` (`:246-258`) are a third accounting of the same bytes.

**The design decision behind it.** The delivery text was written before the
rows existed and kept its own source when the rows arrived.

**The better design.** The delivery excerpt is a projection: at the turn's
end, read the run's `process.output` rows (`SessionLog.display(runId)`, the
read `showOutput` already makes) and take the first `HEAD` and last `TAIL`
characters per stream; `formatBashDelivery` takes `{ head, tail, elided }`
computed from the rows' total length, never optional. The foreground path
keeps a tail only (its result is the tool result, not a delivery) and
whitespace trimming is applied once to the final text, so the option goes.
Deleted: `createBoundedOutputCapture`, `BoundedOutputCapture`,
`toDeliveryExcerpt`, `captureOptions`, `recordedChars`/`capReached` (the cap
is the writer's, `BASH_BACKGROUND_LOG_CAP_CHARS` applied in `logger.output`),
`BashDeliveryStreamExcerpt`'s two optionals. About 120 lines.

**What we give up.** A delivery excerpt that includes output the 200k cap
dropped (today the capture sees every chunk, the rows do not); the excerpt
then says what the log says, which is the honest reading.

**Change amplification.** "A second process child kind with output" (an agent
CLI's streamed text, R5's own example): today its own capture plus its own
excerpt formatter: 2; after: the same projection over its rows: 0.

**Depends on:** none (R5 landed).

---

## Finding 7. Eleven process-lifetime facts live in module-level `let`s and `Map`s, two of them deciding the proxy policy differently

**Red flags:** shared mutable state at module level (the root `AGENTS.md`
"No shared mutable state" rule: an injectable, resettable handle); reinvented
primitives (`Effect.cached`, `Context.Reference`); two representations of
one fact (the outbound proxy policy).

**Evidence.** Module-level state in the area, with the Effect value it stands
for:

| Site                                                                 | What it holds                                      | Primitive                           |
| -------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------- |
| `utils/system/toolUtils.ts:39,53-62` `foundImageTool`                | a memoised probe (misses not memoised)             | `Effect.cachedWithTTL(probe, (exit) => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)` |
| `platform/defaults/nodeProcesses.ts:101,111` `linuxBootId`           | a memoised file read, kept only on success         | the same `cachedWithTTL` with an exit-dependent TTL |
| `platform/defaults/nodeProcesses.ts:214,227-233` `selfIdentity`      | a memoised probe, retried until it succeeds        | the same `cachedWithTTL` with an exit-dependent TTL |
| `platform/defaults/longRunningModelTransport.ts:35,44` `dispatcher`  | one undici agent, built on first use              | `Layer.scoped` + `Effect.acquireRelease` (the agent's `close` as the release) |
| `platform/defaults/longRunningModelTransport.ts:57,154` `projectDispatchers` | one agent per project proxy policy, never released | `RcMap.make({ lookup, idleTimeToLive })` keyed by policy |
| `tools/web/WebFetchTool.ts:113-119` `dispatcher`                     | a second undici agent, from `process.env` only    | the same `RcMap` entry for the project's policy |
| `utils/system/platformPaths.ts:76` `cachedExtendedPaths`             | an `LRUCache` of extended PATHs                    | `Context.Reference` (as `ContentHashes` does, `common/plugins/pluginDigest.ts:42-47`) |
| `platform/defaults/fileSecrets.ts:42`, `platform/defaults/jsonStore.ts:106`, `tools/memory/memoryFileSystem.ts:95`, `tools/approval/approvedWrite.ts:43` | four `PerKeyLanes` maps | `Context.Reference<PerKeyLanes>` with a `Map` default |
| `logger/logSink.ts:143-144` `sink`, `sinkTrusted`                    | the host's log sink                                | documented host port; stays         |
| `utils/files/externalRoots.ts:89` `roots`                            | the external-root allowlist                        | refuted (`SCOPE-external-roots-standalone-service`); stays |

The proxy pair is the one with a behavioural difference: `runModelFetch`
reads the project's `.env` `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` over the
process's (`longRunningModelTransport.ts:137-156`), while `webFetchDispatcher`
builds its agent from `process.env` alone (`WebFetchTool.ts:115-119`), so a
project whose `.env` names a proxy sends its model traffic through it and its
`web_fetch` traffic around it. Two readings of "this project's proxy policy".

**The design decision behind it.** Each module memoised or pooled for itself
because no process value owned the fact.

**The better design.** The memos become `Effect.cachedWithTTL` with an
exit-dependent TTL (infinite on success, zero on failure): `Effect.cached`
alone would memoise the failure too ("its result is computed only once";
only interruptions are never cached, `dist/Effect.d.ts:13490-13502`), which
is not what any of the three sites wants; the exit-function form is the shape
`pluginCatalogLayer` already uses (`tools/pluginCatalog.ts:61-70`). The dispatchers become one `RcMap<ProxyPolicy, Dispatcher>`
in the process layer, read by both `runModelFetch` and `web_fetch` with the
project's policy, so the pair collapses to one fact. The four lane maps
become one `Context.Reference<PerKeyLanes>` each, defaulting to a fresh `Map`,
which is what the "state tests must isolate sits behind an injectable,
resettable handle" rule asks for and costs one line per site. The LRU
follows `ContentHashes`'s precedent.

**What we give up.** Nothing user-visible; `web_fetch` starts honouring a
project proxy, which is a fix.

**Change amplification.** "A test that isolates two sessions' lanes" or "a
second process layout in one Node process" (the desktop's many projects):
today 4 maps and 7 lets are process-global by construction; after: each is a
reference the layer provides.

**Depends on:** none.

---

## Finding 8. The platform ports carry app facts as optional members and carry process-wide roots as per-session fields, so the same fact has a service and a field

**Red flags:** two representations of one fact (`WorkspaceRoots.globalStorage`
beside `GlobalStorageFs`; `WorkspaceRoots.globalState` beside `AppState`);
optional members on a port (`teamMembers?`, `resourcesRoot?`, `commandDirs?`)
that are "unknown by default"; a pass-through layer (`AppState.layer`).

**Evidence.**

- `WorkspaceRoots` (`platform/workspaceRoots.ts`) documents its own
  duplication: `globalStorage` is "process-wide by construction ... and
  carried here rather than as a process-wide value" (`:32-37`), `globalState`
  "process-wide by construction like globalStorage ... Inside Effect the owner
  is the `AppState` service" (`:51-55`). Readers: `.globalStorage` 3,
  `.globalState` 14, `GlobalStorageFs` 15. R8 names the tag side (one
  `SessionRoots` with the rooted filesystems as fields; its second half is
  unlanded, `2026-11-06-root-designs-pr1-compromises.md` §1.5); the data side
  is this: a root record that restates two process services.
- `AgentDirectoriesPort` (`platform/interfaces.ts:82-112`): `teamMembers?`
  (`:102-105`) is TeXRA's team concept passed through the harness
  (`agent/index/agentCatalog.ts:188,267,329`,
  `agent/workspaceAgents/WorkspaceAgentsController.ts:48,94`) so that the
  app's `teamMembers` (`packages/texra/src/shared/agentTeams.ts:241`) can be
  called from the harness's controller: the app's vocabulary as a port
  member, with `?.(...) ?? ...` at the read (`WorkspaceAgentsController.ts:94`).
  `resourcesRoot?` (`:111`) is read at `agent/index/BundledAgentDirectories.ts:29-43`,
  `agent/index/AgentDirectoryService.ts:68-76,283`, `tools/agentCatalogFollower.ts:167-179`:
  three readers each re-deciding "packaged or not" from `undefined || ''`.
  Implementations: 2 (`platform/defaults/sdkPlatform.ts:78-82`,
  `packages/texra/src/controllers/texraProcessLayer.ts:119-130`).
- `AppState.layer(store)` (`platform/interfaces.ts:35-42`) forwards `get`,
  `update`, `modify` one-to-one to add `changes: () => Stream.succeed(undefined)`:
  an SDK store that never signals, which `pluginCatalogLayer`'s switches
  (`tools/pluginCatalog.ts:108-124`) and `agentCatalogFollower`'s three
  feeds then follow once and never again. Documented (`:25-31`), but a
  `StateStore` with no feed is a `StateStore`, not an `AppStateStore`; the
  type should say so rather than the layer faking the member.
- `AgentPlatform.commandDirs?` (`platform/agentPlatform.ts:20`) is `undefined`
  for the SDK and a function for the app; `CommandDirs` is already a
  `Context.Reference` with a default (`utils/system/platformPaths.ts:37-40`),
  so the optional on the platform record is a second default for the same
  fact (`effect/processLayer.ts:245-247` turns one into the other).

**The design decision behind it.** The ports were sized to what TeXRA's
hosts hand over, with the SDK's absences as optionals, instead of to what the
harness decides.

**The better design.** `WorkspaceRoots` loses `globalStorage` and
`globalState` (readers take `GlobalStorageFs` and `AppState` from context; the
3 and 14 reads are inside Effect programs). `AgentDirectoriesPort` is the
three readers (`custom`, `customConfigured`, `builtIn`); `resourcesRoot` is a
field of the app's `AgentDirectoryService` options read by the two agent
modules through one `packaged: boolean` the service computes once; `teamMembers`
moves to the app: the harness's `WorkspaceAgentsController` takes a
`members: (teamId) => Effect<...>` in its deps from the app's composition
root, which already builds it (`texraProcessLayer.ts:128`), and the port
stops carrying it. `commandDirs` is provided as `Layer.succeed(CommandDirs)`
by the app's root and dropped from `AgentPlatform` (the reference's default
is the SDK's answer). `AppStateStore.changes` becomes required and
`AppState.layer` takes an `AppStateStore`, so an SDK store with no feed says
so in its type.

**What we give up.** An embedder constructs a `changes` stream (one line:
`Stream.succeed(undefined)`) instead of the layer doing it silently.

**Change amplification.** "A fourth host": today implements
`AgentDirectoriesPort` with two optionals it must know the harness reads
(`resourcesRoot` gates the whole catalog, `agentCatalogFollower.ts:167-170`),
and a `WorkspaceRoots` of 8 fields, 3 of them copies of process services:
10 decisions; after: 3 readers and 5 fields.

**Depends on:** R8's second half for the tag side; the field and port
deletions can land alone.

---

## Finding 9. `agentCatalogFollower` holds three subscriptions on overlapping keys and a readiness `Deferred` for "the first load happened"

**Red flags:** reinvented primitive (a `Deferred` completed by
`Effect.ensuring` on the first element of a stream); one key subscribed
twice.

**Evidence.** `tools/agentCatalogFollower.ts`: `appState.changes([CUSTOM_AGENT_DIR])`
(`:212`) re-registers the root and re-watches the directory;
`appState.changes([ACTIVE_TEAM_ID])` with `Stream.drop(1)` (`:233-234`)
repaints; `appState.changes([DISABLED_TOOLS, INSTALLED_PLUGINS, CUSTOM_AGENT_DIR])`
(`:245-257`) reloads, with `loaded = Deferred.make` (`:244`),
`Effect.ensuring(reload, landed)` on every element (`:253`) and
`Deferred.await(loaded)` (`:258`) so the layer build waits for the first
load. `CUSTOM_AGENT_DIR` is in two feeds, so a directory change reloads
twice (once from the watcher's debounce, once from the feed).

Open PR 14773: this module serves the agent catalog that proposal redesigns;
sequence after it.

**The better design.** One `appState.changes([...four keys])` feed:
`Stream.take(1)` + `Stream.runDrain` with the reload in the build for the
first load (no `Deferred`), then the rest forked with `Effect.forkScoped`, the
directory re-registration and watch under `Stream.switchMap` so a changed
setting interrupts the previous watcher; a directory change reloads once.
About 25 lines fewer; `loaded`/`landed` go.

**Depends on:** none.

---

## Finding 10. `utils/` holds three modules with domain owners, and `utils/core/index.ts` is a barrel of three unrelated things

**Red flags:** conjoined files / vague names (`index.ts`, `toolUtils.ts`,
`system/`); a layer exception written into the guide instead of fixed.

**Evidence.**

- `utils/core/index.ts` exports `normalizeFilePath`/`getBasename`/`getFileStem`
  (path basics on `pathe`, `:21-51`), `aggregateError` (`:63-70`, 0
  production callers outside its definition) and `jitteredExponentialBackoffMs`
  (`:88-100`, 1 harness caller plus the `plugins.ts:222` re-export). 19
  files import `'@utils/core'`; 18 of them for `normalizeFilePath`/`getBasename`.
  The guide forbids convenience barrels (root `AGENTS.md`, "No convenience
  barrels"); this one is named `index` and holds no public surface.
- `utils/system/execUtils.ts:79-105` reads `WorkspaceStateKey.GIT_MARK_COMMITS`,
  `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` through `Settings`: a domain fact
  (the project's commit identity) decided inside a helper the guide lists as
  "the known exception" that reaches `shared/` (`packages/harness/AGENTS.md:30`).
  Every caller passes `settings` (`:179`, required) so the helper can read a
  setting most commands never need (13 of the callers pass `quiet: true`
  probes; `executeCommand` option usage: `quiet` 13, `channel` 4,
  `maxBuffer` 3, `buffer` 2, `killProcessTree` 2).
- `utils/system/toolUtils.ts` is "which of ImageMagick or GraphicsMagick is
  installed" (`:47-64`): one consumer, `agent/runtime/run/img.ts:110,267`.
  Its name says nothing; its owner is the image step.

**The better design.** `utils/core/index.ts` becomes `utils/core/pathBasics.ts`
(what it is), `aggregateError` is deleted, `jitteredExponentialBackoffMs`
moves beside `backoffSchedule.ts` (the refuted candidate keeps the function,
not its file). `gitAuthorEnv` moves to the one caller that runs git commits
with the agent identity (the app's git plugin passes it as `env`), and
`ExecuteCommandBaseOptions.settings` goes, which deletes the layer exception.
`toolUtils.ts` becomes `agent/runtime/run/imageTool.ts` (or a section of
`img.ts`).

**What we give up.** A `git commit` the model runs through `bash` would need
the identity threaded by the bash tool (`tools/bash.ts:360` passes
`settings` today); that is one caller, and the honest owner.

**Change amplification.** "A new per-command setting": today a required
option on every `executeCommand` caller (56 files per the refuted
`RT-execute-command-lift` entry); after: the callers that need it.

**Depends on:** none.

---

## Finding 11. Smaller items, batched

- **`JsonStore` has two one-caller options.** `follow?: boolean`
  (`platform/defaults/jsonStore.ts:46`; 1 caller,
  `packages/cli/src/runtime/cliService.ts:92`) turns every `get` into a
  synchronous `statSync` compare and re-read (`:51-66,189-211`) with a
  `writeLogLine` on failure; the comment says the compare costs "about a
  microsecond", in which case every store should follow and the option is a
  decision refused; the Effect-native form of "follow other writers" is
  `FileSystem.watch(path)` (`dist/FileSystem.d.ts:324`, a `Stream`) applied
  into a `SubscriptionRef<JsonRecord>` the reads take from, as
  `FileSecrets.watch` already does for the secrets directory. `onUnreadable?: (error) => void` (`:37`; 1 caller,
  `packages/texra/src/platform/defaults/nodeStores.ts:91`) is a callback
  where `JsonStore.open` failing and the caller `Effect.catch`ing into
  `JsonStore.empty(path)` is the Effect shape.
- **`FileSecrets.watch` builds a throwaway `FileSecrets(directory, () => {})`**
  to call `listStoredKeys` (`platform/defaults/fileSecrets.ts:141`) and ends
  with `Effect.never` after forking the watch (`:172`): the watch stream
  `runDrain` is the fiber; `listStoredKeys` is a function of a directory, not
  a method.
- **`viewDiagnosticsLayer` rewrites ERROR/FATAL to WARN because "Electron's
  smoke harness treats `console.error` as a failed view"**
  (`platform/processRuntime.ts:174-186`): a test harness's rule inside the
  production logger, special and general mixed. The harness's filter belongs
  in the harness.
- **`Plugin.toggle` requires `Plugin.availability`**, checked at table build
  (`tools/toolTable.ts:225`; `tools/plugins.ts:117,122`): a pair of optionals
  whose legal combinations are three of four. A `switch?: { probe: ToolAvailabilityChecks; initially: 'on' | 'off' }`
  makes the check unnecessary. `injectedWhen`'s `string | true` (`:128`,
  read at `agent/runtime/agentToolResolution.ts:122`) is a setting key or
  "no setting": a literal standing in for "always".
- **`ExternalToolCheckResult.status` re-encodes the probe's `available: boolean`**
  plus the failure path into three literals (`tools/toolAvailabilityService.ts:20`,
  `tools/toolAvailability.ts:319-338`); fine as a sum, but `statusLabel?`/`statusDetail?`
  are optional on both the probe answer (`tools/toolProbes.ts:84-85`) and the
  result (`toolAvailabilityService.ts:21,23`), so the dashboard writes `??`
  twice for one absence.

---

## Found by round 1 or the root notes; this area's new angle only

- `tools/ExecutionsTool.ts`'s `waitOver` (`:360-370`: `runs.get(runId) === undefined`
  as liveness, `run.status !== 'ready' && !isInFlightPhase`), `awaitStatusChange`
  (`:95-124`: a joined status string compared on every view change, `Effect.never`
  at `:118`, `getUnsafe` at `:118,380`) and `send.ts`'s `missingRun`
  (`tools/executions/send.ts:37`): R6 (`working`/`holder` on the view) and
  R2. New angle: once the view carries `working`, the whole wait is
  `SessionViewAccess.changes.pipe(Stream.filter(v => ids.every(id => !v.runs.get(id)?.working)), Stream.runHead, Effect.timeoutOption(...))`,
  and `RunToolContext.runs` (`:75-79`) and `SessionReads` (`:155-156`, the
  `infer` over `RunCallShape.session`, E5/R8) go.
- `tools/ExecutionsTool.ts:308` `Context.get(session, Runs)` and
  `Effect.provide(session)` at `:343`, `tools/plan/PlanTool.ts:309`,
  `tools/codemode/ScriptTool.ts:189,197`, `tools/codemode/SelfTool.ts:225`,
  `tools/bash.ts:334`: E5 / R8 second half (`RunCallShape.session` as `runs`).
- `toolPolicy.stopAfterCycle === true || config.script != null`
  (`tools/plan/PlanTool.ts:104-105`): E4's trust-by-kind sites.
- The executions input union and the `path`-on-every-branch rule
  (`tools/executions/toolInput.ts:134-136`): E6.
- `ProcessReport.failure` beside `exit`, `childEndReport`, the
  `:interrupted` delivery id: `2026-11-06-root-designs-pr1-compromises.md` §3.

## Controllers: what the root notes still name in the tree

Not new findings; recorded so the slice that claims them can be checked.
`controllers/session/sessionStore.ts` still holds `settlement` (`:96`),
`delivered` (`:184`), `tailEnded` (`:185`), `foldedRead`/`foldedEnded`
(`:187-188`) and `now: () => SubscriptionRef.getUnsafe(database.observedCommit)`
(`:223`), all on R1's delete list; `controllers/session/currentValues.ts:50`
`READ_RETRY` is the global store's change poll R1 keeps. `platform/defaults/nodeProcesses.ts`
(the process start identity) serves `ProcessIdentity`
(`controllers/session/Database.ts:203`), which R1 keeps for the global
store's multi-process record; its two module-level memos are finding 7's.
The eight `*Unsafe` in controllers are `SubscriptionRef.getUnsafe` snapshot
reads under R1/R8.

## Good modules in this area

- `tools/core/definition.ts` `defineTool` (E's verdict stands) and
  `tools/core/inputSchema.ts` `nullishWithDefault`.
- `platform/defaults/nodePlatform.ts` `supervisedSpawner` (`:203-322`): one
  `uninterruptibleMask` that owns a real invariant (a spawned child's scope is
  registered before any interrupt can land), a bounded teardown, and the
  `exit` listener as `acquireRelease`. The one masked region in the area that
  earns it.
- `utils/files/rootedFileSystem.ts`: one implementation for three rooted
  services, the standard `FileSystem` interface, `BadArgument` for an escape;
  `utils/files/fsDurability.ts` and `fsEntryExists.ts` (`absentReason` as the
  one reading of "nothing is there").
- `tools/jsonRpc.ts`: two framings, one close protocol, pending requests
  failed with a reason on every path, the cancel notice on interrupt. The
  refuted `EFF-ADOPT-mcp-client` entry is right to keep it.
- `tools/sessionTools.ts` `follow` (`:136-168`) and `pinStep` (`:174`): `RcMap` and
  `Scope.fork` used as the lifetimes they are; `PluginHold` as a scope hand-off.
- `common/plugins/hookProtocol.ts` `interpretHookRun`: the reference's whole
  exit-code and JSON grammar in one pure function with every ignored field
  named.
- `common/plugins/pluginTrust.ts` `readInstalledPluginLoad`: never fails,
  every withheld plugin says why, one trust key.
- `logger/logSink.ts` + `redaction.ts` + `formatLogData.ts`: render once,
  redact once, bound once, in that order, with the order explained by what
  breaks otherwise.
- `common/errors/sdkError/providerErrorFormat.ts` `failureIn`: one decision of
  what a failure is for every reader (#14776 made it so).
- `tools/executions/queryAction.ts`, `scriptCallsView.ts`: bounded
  projections with their bounds in the output.

## Already settled, left alone

- `withPerKeyLane` over a `Semaphore`: `EFF-ADOPT-per-key-lane-semaphore`.
  Its two `*Unsafe` (`utils/core/perKeyQueue.ts:69,86`) are counted above and
  not re-proposed; finding 7 moves only the maps that hold the lanes.
- `externalRoots` as a module-level registry: `SCOPE-external-roots-standalone-service`.
- `tools/timeouts.ts`: `EFF-ADOPT-timeouts-already-effect`;
  `jitteredExponentialBackoffMs` kept as a function: `EFF-ADOPT-jitter-helper-stays`
  (finding 10 moves its file, not its contract).
- The stdio MCP client over `jsonRpc.ts`: `EFF-ADOPT-mcp-client`.
- `executeCommand` as a program, not a lifted lane: `RT-execute-command-lift`
  (finding 10 narrows its options, not its shape).
- `ToolCatalog` and `ToolCatalogOwner` as two tags over one object
  (`tools/liveTools.ts:89-110`), `ToolRegistry` apart from the catalog, the
  catalog lifetimes: owner decisions of
  `2026-11-01-tool-layer-one-catalog-one-step.md`.
- `AppSignals` as a `PubSub` with a synchronous `emit` and the
  "no new subscribe surface" rule: `packages/harness/AGENTS.md` "Event
  channels and cards" and `platform/appSignals.ts:12-45`. Finding 1 uses its
  stream form, which exists.
- A hook's minimal environment (`PATH`, `HOME`, `CLAUDE_*`):
  `2026-09-28-code-plugins-hooks-v1.md`; finding 3 leaves it out of the one
  policy.
- `rowCodec`'s version-per-kind and `storeSchema`'s stamp:
  `packages/harness/AGENTS.md` "Storage format".
- `logSink`'s module-level sink: the documented host diagnostic port
  (`logger/logSink.ts:1-18`); a host installs it before any runtime exists.

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

| Finding | Hand-rolled today                                                                                       | Effect primitive and the exported API verified                                                                                                                                                                                                                                                                                    | Why it fits                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `ProbeRound.again` + `lanes` Map + `Semaphore(1)` claim + `Effect.uninterruptible` fork + `while (true)` | `SubscriptionRef.make/set/changes` (`dist/SubscriptionRef.d.ts:93,1102,134`) + `Stream.switchMap` (`dist/Stream.d.ts:2505`, "interrupting the previous stream when a new element arrives", since 4.0.0)                                                                                                                              | latest inputs win and a stale probe cannot finish last, with no flag, no lane and no mask                                                                        |
| 1       | `held: Map<root, inputs[]>` refcount in `hold`'s `acquireRelease`                                       | `RcMap.make({ lookup })` / `RcMap.get` in the session's scope / `RcMap.keys` (`dist/RcMap.d.ts:215,379,654`)                                                                                                                                                                                                                    | release is counted per borrower scope (`src/RcMap.ts:783-800`); the last session's close drops the root's entry                                                 |
| 1       | `Queue.unbounded` + `Queue.offerUnsafe` listener + `Deferred subscribed` + `Effect.forever` drain       | `appSignalStream` = `Stream.fromSubscription` (`dist/Stream.d.ts:1217`) over `PubSub.subscribe`, then `Stream.filter`/`Stream.runForEach` (`:5253,15953`)                                                                                                                                                                      | the hub is already a `PubSub`; a stream over its subscription needs no relay queue and no readiness latch                                                       |
| 2       | `acquireMcpServer` answering `{ tools: new Map(), failure }` + `failed: Set<ServerKey>`                 | a failing lookup under `RcMap.make({ lookup, idleTimeToLive })`; `RcMap.getOption` + `RcMap.invalidate` + `RcMap.keys` (`dist/RcMap.d.ts:520,701,654`). Verified: a failed lookup is kept and re-fails every `get`/`getOption` (`src/RcMap.ts:590-595,617`); only an interrupted one is removed (`:761-775`)                          | the map already remembers a failed key, so the `Set` is the primitive written twice; `ScopedCache.makeWith`'s exit TTL (`dist/ScopedCache.d.ts:117-122`) rejected: no per-borrower release |
| 3       | four spawn-time scrub policies                                                                          | none: pure data (one `childEnvironment` function over `environment`, a `Context.Reference`, `utils/system/nodeWorkspace.ts:65`)                                                                                                                                                                                                | a decision, not a lifetime                                                                                                                                       |
| 4       | results scan + `stillRunning` walk + `GOAL_AUTO_APPROVALS` mode                                         | none: a row (the plugin's own `plugin.fact`) read through `SessionLog.facts`; the view's `durableOutcome`                                                                                                                                                                                                                       | one owner per fact; R7's "a question/answer is a row" applies to a launch too                                                                                    |
| 5       | `getAvailablePaths` switch + per-handler refusals + `HIDDEN_CONFIG_FIELDS_BY_CATEGORY`                  | none: a column on `EXECUTION_ROUTES`                                                                                                                                                                                                                                                                                             | a declarative table with the missing column                                                                                                                      |
| 6       | `createBoundedOutputCapture` head/tail + `normalizeWhitespace` + `capReached`                           | none new: a projection over the `process.output` rows `SessionLog.display(runId)` already returns (`tools/executions/processOutput.ts:135-137`)                                                                                                                                                                                 | R5's named step: the rows are the one record                                                                                                                     |
| 7       | `foundImageTool`, `linuxBootId`, `selfIdentity` lets                                                    | `Effect.cachedWithTTL(self, (exit) => Duration)` (`dist/Effect.d.ts:13969`; "the function runs once after each fresh computation, including failures", `:13561-13564`). Not `Effect.cached` (`:13539`): it memoises a failure ("computed only once", `:13490-13502`)                                                             | success-only memo with a retried miss, which is what all three sites hand-roll                                                                                   |
| 7       | undici `dispatcher` lets and `projectDispatchers` Map                                                   | `Layer.scoped` + `Effect.acquireRelease` (`dist/Effect.d.ts:12676`) for the process agent; `RcMap.make({ lookup, idleTimeToLive })` keyed by proxy policy for per-project agents                                                                                                                                              | a pooled connection agent is a resource with a lifetime; one map answers both `web_fetch` and the model transport                                                |
| 7       | four module-level `PerKeyLanes` maps, `cachedExtendedPaths` LRU                                         | `Context.Reference(key, { defaultValue })` (`dist/Context.d.ts:1741-1743`), the precedent being `ContentHashes` (`common/plugins/pluginDigest.ts:42-47`)                                                                                                                                                                       | process-wide by default, replaceable per layer, resettable in tests; `withPerKeyLane` itself stays (refuted candidate)                                           |
| 8       | `WorkspaceRoots.globalStorage/globalState` fields; `AppState.layer` faking `changes`; optional port members | `Context.Service` tags already in place (`GlobalStorageFs`, `AppState`); `Layer.succeed(CommandDirs)` for the app's dirs (`CommandDirs` is a `Context.Reference`, `utils/system/platformPaths.ts:37-40`); a required `changes: Stream` on the SDK's store                                                                      | one owner per fact; a default belongs on the reference, not on the record                                                                                        |
| 9       | three `appState.changes` feeds + `Deferred loaded` + `Effect.ensuring(reload, landed)`                   | `Stream.merge`-free single feed over four keys; `Stream.take(1)` (`dist/Stream.d.ts:8827`) + `Stream.runDrain` (`:16198`) for the first load; `Stream.switchMap` (`:2505`) for the watcher; `Effect.forkScoped` (`dist/Effect.d.ts:17216`)                                                                                   | "the first element happened" is `take(1)`, not a latch                                                                                                           |
| 10      | `utils/core/index.ts`, `execUtils.gitAuthorEnv`, `toolUtils`                                            | none: file moves and one option deleted                                                                                                                                                                                                                                                                                          | naming and ownership                                                                                                                                             |
| 11      | `JsonStore.follow` stat-compare on every `get`; `FileSecrets.watch`'s `Effect.never`                     | `FileSystem.watch` (`dist/FileSystem.d.ts:324`) into `SubscriptionRef`; `Stream.runDrain` as the watch fiber instead of fork + `Effect.never`                                                                                                                                                                                  | a file that others write is a stream of changes, not a poll on read                                                                                             |

Primitives named by the brief and not used by any finding here: `Latch`
(`dist/Latch.d.ts:189,209,253,303,351` exist; no finding in this area waits on
a gate; the one readiness `Deferred` the area had, finding 9, is a
`Stream.take(1)`), `FiberMap` (`dist/FiberMap.d.ts:115,1016,881,1244,1274`;
the area's fibers are per-`RcMap`-entry and per-stream, so an entry's scope,
`Scope.fork` (`dist/Scope.d.ts:493`), is their owner, as `sessionTools.follow`
already does), `Schedule` (`dist/Schedule.d.ts:725,1070,981,1212`; finding 2's
retry variant is `Effect.retry({ schedule })`, `dist/Effect.d.ts:7132`).
