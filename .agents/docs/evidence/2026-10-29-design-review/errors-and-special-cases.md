# Errors, special cases, and where complexity lands (APSD ch. 6, 8-10)

Revisions: TeXRA `cae1afc30a` (paths under `packages/harness/src/` unless a package is named), pi `c3d8ce4` (paths from repo root), DeepSeek `f3803c96` (paths from repo root). Peer sweeps were run by two helper agents and spot-checked by me (pi `scheduler.ts:2329-2352`, `tool.ts:196-214`, `agent-loop.ts:895-911`; DeepSeek `repair.ts:160-170`, `known-event-types.ts:20-56`, `user-approval/src/index.ts:306-320`, `session-persistence-jsonl/src/index.ts:1188-1212`). Their rerunnable scripts: `scratchpad/apsd-1029/err/count.sh` (pi) and `err/files.txt` (DeepSeek core list).

## 1. Verdict

pi does this lens best, narrowly. Its core contains no tool-name branches and no provider literals, and it treats app vocabulary as opaque data. Ownership errors are made impossible: every queued write rechecks its invocation on the serialized path. TeXRA is the strongest at defining durable errors out of existence: retry budgets are counted from rows, a child's result and its parent's delivery commit in one transaction, and `run.end` is written once. But its approval path is organized around one tool's name, and its request protocol hands callers a decision-by-kind cross product they must defend against. DeepSeek reports uncertainty honestly and keeps its loop general. Its vocabulary leaks in through a generated event catalog, though, and optional services push probing onto every caller.

- **pi: A-.** General core, idempotent submissions, gated commits. It pushes impossible `Result`s up from infallible env operations.
- **TeXRA: B+.** A for crash-safe define-out. C+ for special/general separation in the approval path and the request door.
- **DeepSeek: B.** Checkpoint-then-dispatch and honest tail repair. Vocabulary leaks into the core; `undefined` is overloaded in its results.

## 2. Findings

### TeXRA

**Positive: define errors out of existence.**

- _Idempotent end._ `endIn` reads the run's committed end inside the publisher's transaction. An existing end "stands", and a second end writes nothing (`agent/storage/runLifecycle.ts:235-242`).
- _One transaction for a child's result._ A child turn's rows and the parent's queued delivery commit in one SQLite transaction (`agent/runtime/childTurnResult.ts:1-9`). A last turn rides the `run.end` append (`runLifecycle.ts:267-276`). "Finished, but the parent never heard" cannot happen.
- _Retries decided by rows._ `nextAttempt` is a pure, exhaustive switch over the invocation's rows (`shared/session/inFlight.ts:203-236`). `failedNext` counts the budget from `failed` rows, so a crash cannot refill it (`:259-279`). An approved attempt with no recorded outcome is asked about again, never resent (`:211-215`).
- _Deduplicated follow-ups._ A repeated `followUpId` answers `duplicate` with no row (`agent/followUp/Inbox.ts:316-330`).
- _Contract and tests._ Nine numbered durable invariants, I1-I9 (`packages/harness/README.md:281-301`), each cited by a conformance test the checker requires (`scripts/core-quality-measure.mjs:111-112`).

**Positive: a mutually exclusive result instead of throw and catch.** `resumeRun` returns `{ ownedBy }` as a result (`agent/runtime/resumeRun.ts:61-64,192`), and callers branch on it directly (`effect/sessionPrograms.ts:200-203`, `agent/followUp/ToolUseFollowUp.ts:224-225`).

**Negative: special-general mixing in the approval path.**

- `const SHELL_TOOL = 'bash'` (`agent/runtime/loop/toolGuard.ts:33`) and `grant: tool.definition.name === SHELL_TOOL ? 'shell' : 'call'` (`:105`) make the general guard branch on one tool's name.
- The public `ToolGuard.bash` field (`agent/core/tools/ToolTypes.ts:40-47`) is declared by MCP (`tools/mcp/mcpServer.ts:207-208`), Codex (`packages/texra/src/tools/codex.ts:471-472`), Claude (`claudeAgent.ts:545-546`) and the terminal tool (`setup/SendToTerminalTool.ts:105-106`). Every one of those calls opens a request of kind `'bash'` (`shared/schemas/progressView/data.ts:166`).
- The bypass vocabulary is named after tools: `['bash', 'toolEdit', 'superYolo']` (`shared/approvalBypassKind.ts:13`), mapped in `runApprovalQueue.ts:280-287` and special-cased again at `:305`.
- Inferred, not tested: a plugin tool registered under the name `bash` would inherit the shell grant.
- Open PR #14413 moves this test but keeps it (`definition.name === SHELL_TOOL && guard?.bash`, diff line ~1003).

**Negative: complexity pushed up through the request door.**

- `PermissionPayload` has 7 kinds (`data.ts:161-185`) and `RequestDecision` has 9 actions (`shared/schemas/request.ts:21-75`). Neither is keyed by the other.
- `decideRequest` records any action for any pending kind without checking that the action fits (`controllers/session/SessionRequests.ts:237-270`). The mismatch is detected only afterward, by readers.
- The readers disagree. `refusalOf` turns a mismatch into `deny` (`shared/session/approvalDecision.ts:32-35`), while `nextAttempt` turns any non-retry, non-deny answer to a retry request into `cancel` (`inFlight.ts:231-235`). The same impossible state has two meanings: information leakage plus change amplification.
- The same pattern holds one level up. `request` returns the 5-case `Outcome` for all 13 request kinds (`effect/sessions.ts:255-257`, `shared/session/runtimeRequest.ts:231-248`). Callers die on cases that cannot occur (`packages/texra/src/controllers/session/hostRunActions.ts:609-611`) or invent a fallback (`packages/cli/src/commands/tasks.ts:268`: `outcome.kind === 'followUp' ? outcome.status : 'sent'`).
- Measured: 12 `outcome.kind` narrowing sites across hosts and app (`grep -rnE "\.kind (!==|===) '(done|followUp|forked|preview|runFiles)'"` over `packages/{cli,desktop,extension,texra,harness}/src`, tests excluded).

**Negative: provider vocabulary in the run path.** `agent/runtime/run/pricing.ts:35-45` switches on `providerUsage.kind` (`anthropic`, `google`, `xai`) to pull out cache-creation and tool-prompt tokens. That is normalization the llm package should own.

**Silent-failure audit.** The core-quality checker measures 4 syntactic forms (`scripts/core-quality-measure.mjs:1074-1102`), and its baseline holds 8 harness sites in 4 files (`config/ratchets/core-quality/silent-degradation.json`). It does not see `Effect.catch(() => Effect.succeed(v))`, `catchIf`, or neutral `default:` branches. My method:

1. A Python scan of all 410 non-test `.ts` files (84,313 LOC) for `Effect.(catch*|orElse*|ignore*)`. A site counts as "quiet" if its 4-line window has a succeed, void or null result and no log, fail, warn or surface call.
2. A scan of `switch` `default:` branches.

Results:

- **Effect handlers:** 192 sites, 35 quiet-looking.
- **Sample of 14 read:**
  - 11 translate the failure into a value the caller shows: an MCP error result (`tools/mcp/mcpServer.ts:235`), a hook marked `unstartable` (`common/plugins/pluginHooks.ts:330`), a memory miss (`agent/prompt/templateInputs.ts:377`), a route reason (`agent/runtime/modelAccess/routeDecision.ts:157`), and others.
  - 3 are documented conservative defaults. For example, an argument check that fails means "not replay-safe; ask" (`agent/runtime/run/tools.ts:130-140`).
  - None hides a real failure.
- **Switch defaults:** 32 in total. 11 are exhaustive (`never`, `absurd`, or throw). 21 return a neutral value over a closed union. One of those decides lifecycle edges: `edgesOf` gives every unlisted row `closes: false, borrowsClaim: false` (`shared/schemas/sessionEvent.ts:425-444`), so a new row kind that should close an aggregate would compile silently.

**Undocumented defaults on persisted data.** `withDecodingDefault` fills `run.end` output fields (`shared/schemas/runRecords.ts:69-78`) and 9 accounting totals (`shared/schemas/usage.ts:126-155`). Both exist so that `emptyRunEndOutput` and the empty totals can be built by decoding `{}` (`runRecords.ts:84`, `usage.ts:160`). Root AGENTS.md allows a default on lifecycle and accounting data only for a documented absent field. `runRecords.ts:65` also cites "section 3.4", a document citation in code.

**Error-dense spot.** `finalizeRun` (`runLifecycle.ts:326-395`) holds 5 of the 19 catch, exit or result sites across the loop, invocation, lifecycle and registry files (`grep -cE 'Effect\.(catch|orElse|ignore|exit\(|result\()'`). It tries the end, reads back, writes a lost-result notice, then a FAILED backstop. The read-back is justified: a publication cut at the close deadline may or may not have committed (`agent/runtime/SessionEvents.ts:70-75`). This is real uncertainty, not a missed definition.

### pi

- **Positive: gated commits.** `#gated` (`packages/durable/src/harness/scheduler.ts:2329-2352`) rechecks, inside the commit, that the invocation has not ended, that the scheduler is not closing, that the task is running, and that no durable abort mark exists. A stale writer cannot exist; tool authors never handle it. _Define errors out; pull complexity down._
- **Positive: startup reconciliation and idempotent input.**
  - Startup rewrites `running` tasks to `pending` and counts restarts (`scheduler.ts:382-411`). That counter drives the crash-loop cutoff (`harness/live.ts:228-234`).
  - Submissions deduplicate on `requestId` (`harness/submissions.ts:207-215`).
  - `wait()` checks and subscribes in one step on the session line (`submissions.ts:109-121`).
- **Positive: general core.**
  - 0 tool-name branches and 0 provider literals in durable plus agent (`rg -n '(===|!==|case)\s*"(bash|edit|read|write|grep|find|ls|glob)"'`).
  - The `pi.` input-kind prefix is reserved (`submissions.ts:177-185`), and the built-ins are ordinary tasks.
  - Specifics sit in coding-agent: 35 tool-name branches and 33 provider literals.
  - Mild leak: the tool runtime types output with `ShellOutputWindow` (`harness/types.ts:19,252,258`).
- **Negative: errors pushed up.**
  - `ExecutionEnv.joinPath` and `absolutePath` return `Promise<Result<…, FileError>>` with 8 codes (`env/index.ts:35-43,219-220`), yet the Node implementation cannot fail (`env/node.ts:653-659`). Callers `getOrThrow` or translate the impossible.
  - Failure-hiding sites, measured as empty catch + `.catch(() => v)` + catch-return-default: durable 38 in 28.8 KLOC; coding-agent 157 in 76.7 KLOC.
  - A real hide: an `afterToolCall` hook throw replaces a tool result that already succeeded with an error (`packages/agent/src/agent-loop.ts:908-910`). The model is told the effect did not happen.

### DeepSeek (minimal profile unless noted)

- **Positive: checkpoint before side effects.** The policy awaits `sessions.flush` before building the model stream and before a top-level tool body (`packages/session/session-checkpoint-policy/src/index.ts:34-36,64-75`). Nested calls skip the flush (`:71`).
- **Positive: honest repair.** On resume the loop appends `TOOL_OUTCOME_UNKNOWN` or `TOOL_NOT_STARTED` results as an ordinary batch (`packages/core/agent-loop/src/index.ts:799-803`, `packages/core/session/src/repair.ts:32-41,160-193`). It records the uncertainty rather than masking it, and defines out only the provider's dangling-call error.
- **Positive: errors pulled down.** Frozen arguments (`packages/core/tools/src/pipeline.ts:153-157`) mean permission cannot judge a different value than the body runs. Every pipeline failure becomes a `ToolExecutionResult` (`pipeline.ts:177-180,230-231`). An off-vocabulary approval answer is normalized at the boundary (`packages/interaction/user-approval/src/index.ts:311-318`, richer profile).
- **Negative: special-general mixing.**
  - A generated set of 63 plugin event types is compiled into core, including `session-log-deepseek/delivery-accepted` (`packages/core/session/src/known-event-types.ts:22-89`), and persistence enforces it.
  - The session header hard-codes `origin?: 'subagent'` (`packages/core/session/src/types.ts:122`).
- **Negative: complexity pushed up.**
  - `RequestErrorAction = {kind:'retry'} | undefined` (`packages/core/agent/src/runtime-types.ts:149`) uses `undefined` for both "no decision" and "aborted".
  - Listing folds a corrupt session header into `undefined`, with no log (`packages/session/session-persistence-jsonl/src/index.ts:1150-1151,1193-1194`).
  - Optional services are probed with `ctx.get` at 21 code sites, 16 of them in subagent (`packages/subagent/subagent/src/manager.ts:1466-1492`).
  - Measured: 12 silent `.catch` + 3 comment-only catches in 23.8 KLOC of core.

The three measurement methods differ (Effect handlers versus Promise catches), so compare the readings of samples, not raw densities.

## 3. What TeXRA should do

Ranked by complexity removed.

**1. Key the decision by the request kind, and the outcome by the request.**

- _Red flags removed:_ pushing complexity up, information leakage, two meanings for one impossible state.
- _Change:_
  - Add one table, `payload kind → allowed actions`, beside `PermissionPayloadSchema` (`data.ts`).
  - `decideRequest` rejects a mismatched action before recording it (`SessionRequests.ts:237`).
  - Delete the mismatch branch of `refusalOf` (`approvalDecision.ts:32-35`) and the catch-all at `inFlight.ts:233-235`.
  - Type `request` as `<R>(r: R) => Effect<OutcomeOf<R['kind']>, RequestError>` (`effect/sessions.ts:255-257`), then delete the impossible-case `die` and fallback lines at the 12 narrowing sites.
- _Estimate:_ +25 for the table and generic, −30 for 7 `refusalOf` call paths and 12 narrowing sites at about 2 lines each. Net about −5 lines. The real gain is a class of states that can no longer exist. This is a count of sites, not a diff.
- _Peers:_ DeepSeek normalizes answers at the approval boundary (`user-approval/src/index.ts:311-318`); pi's `wait()` returns the narrowed `SettledSubmissionRecord` (`harness/types.ts:104-112`).
- _Status:_ NEW. The prior review §6 suggested the `Outcome` mapping, but no PRD row holds it. The decision half is new. It fits beside row 7, the receipt and protocol work.

**2. Make the shell grant a declaration, not a tool name.**

- _Red flags removed:_ special-general mixing, non-obvious code.
- _Change:_ Rename `ToolGuard.bash` to `command`, with `grant: 'shell' | 'call'` declared by `tools/bash.ts:536`. Delete `SHELL_TOOL` and the name test (`toolGuard.ts:33,105`). In the format batch, optionally rename the persisted `'bash'` payload and bypass kinds to `'command'`. Those are wire strings, so that rename is a format change.
- _Estimate:_ about −3 lines, with 5 declaration sites touched (by grep). `ToolGuard` is public plugin API (`config/api-reports/harness.plugins.api.md:120`), so this must land before the freeze.
- _Peers:_ pi's core has 0 tool-name branches; DeepSeek's pipeline has 0.
- _Status:_ NEW. It touches the same file as row 5 (#14413, which keeps the name test), so land it after that PR.

**3. Drop the decoding defaults on persisted `run.end` output and usage totals.**

- _Red flag removed:_ silent degradation on lifecycle and accounting data.
- _Change:_ Write `emptyRunEndOutput` and the empty totals as literal constants, then remove the 11 `withDecodingDefault` pipes (`runRecords.ts:69-78`, `usage.ts:126-155`). A damaged row then fails by name. Also drop the "section 3.4" citation.
- _Estimate:_ about −10 lines, counted in place.
- _Peer:_ DeepSeek refuses unknown or retired persisted syntax outright (`session-format/src/chain.ts:81-84`).
- _Status:_ NEW, with format-batch timing (row 3). Inferred: no version bump is needed, because every writer writes these fields; check with a grep of the writers first.

**4. Pull provider usage normalization into `packages/llm`.**

- _Red flag removed:_ special-general mixing (provider kinds in the run path).
- _Change:_ Have the llm usage record carry `cacheCreationTokens` and `toolUsePromptTokens`, and delete the switch at `run/pricing.ts:35-45`.
- _Estimate:_ about −10 lines in the harness. The llm side is inferred at +6.
- _Peers:_ pi's core has 0 provider literals; DeepSeek's retry policy is owned by the provider package (`packages/llm/llm-retry/src/index.ts:24,33-35`).
- _Status:_ NEW.

**5. Make `edgesOf` exhaustive.**

- _Red flag removed:_ unknown unknowns.
- _Change:_ Every row kind states its claim and closure edges (`sessionEvent.ts:425-444`).
- _Estimate:_ about +10 lines. This adds lines but removes a silent default on the one fold that decides closure.
- _Status:_ NEW.

## 4. What TeXRA should refuse

- **pi's "first submission wins" on a reused `requestId` with different content** (`submissions.ts:207-215`). It defines the conflict out by hiding it. The prior review's rule stands: return the original receipt for the same request, reject a conflicting one.
- **pi's `Result` returns for infallible operations** (`env/index.ts:219-220`). This is the push-up pattern. Effect's typed error channel already says per operation what can fail.
- **DeepSeek's load-time tail closers as a second recovery path.** TeXRA records the same uncertainty at its write points: `tool.intent` before the body, `reask` for an approved attempt with no outcome (`inFlight.ts:211-215`), and invariant I4. Closers appended at load would be a second writer of the run history.
- **DeepSeek's compiled plugin event catalog** (`known-event-types.ts:22-89`). TeXRA's single `plugin.fact` row with plugin-declared kinds (#14402) keeps the store general. Do not add per-plugin row types.
- **Optional services probed at each call site** (`ctx.get`, DeepSeek subagent). TeXRA's `Context.Reference` defaults are better.
- **pi's generic scheduler as the way to get validity rechecks.** TeXRA gets the same exclusion from claims and the one serialized publisher. PRD row 4 is right to finish that inside `endActivation`.

## 5. Corrections

- **PRD "让复杂状态少出现" table (line 102) and resume step 2 (line 175)** still list the `OwnedByParent → RunFailure → catch → follow` round trip as open work. At `cae1afc`, `ownedBy` is a returned result (`resumeRun.ts:61-64,192`; `sessionPrograms.ts:200-203`), and `grep -rn OwnedByParent packages/harness/src` finds nothing. That row is done.
- **The prior review §6 understates the push-up.** The larger cross product is decision × kind (9 actions × 7 kinds), not just `Outcome`. Two readers already give a mismatch different meanings (`approvalDecision.ts:32-35` reads it as deny; `inFlight.ts:233-235` reads it as cancel).
- **"TeXRA forbids silent fallbacks by rule"** holds by discipline, not by the checker. The checker sees 4 forms (`core-quality-measure.mjs:1074-1102`) and misses `Effect.catch(() => Effect.succeed(v))`, `catchIf` and neutral defaults. My 14-site sample found no hidden failure, but the two persisted-default schemas above violate the written rule.
- **Peer evidence for PRD row 6** (crash-loop cap, +40): pi counts restarts on the task record at open (`scheduler.ts:382-411`) and cuts off at a limit (`live.ts:228-234`). This supports counting from rows. pi's replay rule (`tool.ts:199`) matches TeXRA's (`run/tools.ts:130-131`) exactly. That is convergence, not something to borrow.
