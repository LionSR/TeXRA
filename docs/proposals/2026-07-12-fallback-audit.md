# Fallback audit (2026-07-12)

> **Status:** Open design audit. The source baseline is `7ec2876b9` on
> `origin/main`, inspected on 2026-07-12. File and line references are pins to
> that historical baseline and should be rechecked before implementation. The
> implementation ledger was refreshed against `ef9c4541a` on 2026-07-12.
>
> **Scope:** Production TypeScript and JavaScript under `src/`, `packages/`,
> `scripts/`, and `supabase/`. Tests, fixtures, generated webview bundles,
> dependency trees, and build output are excluded from the quantitative census.

## Implementation ledger

The audit is descriptive; a finding remains open until its pull request is
reviewed and merged. This ledger tracks the first high-impact batch:

| Finding    | Change                                                         | Pull request                                       | Status     |
| ---------- | -------------------------------------------------------------- | -------------------------------------------------- | ---------- |
| `P0.S1/S4` | Require relay enforcement and distinguish unavailable spend    | [#8269](https://github.com/LionSR/TeXRA/pull/8269) | Merged     |
| `P0.S2`    | Require a configured signup-hook verification secret           | [#8268](https://github.com/LionSR/TeXRA/pull/8268) | Merged     |
| `P0.S3`    | Require an explicit boolean device-approval decision           | [#8266](https://github.com/LionSR/TeXRA/pull/8266) | Open draft |
| `P0.1`     | Retry or quarantine every unacknowledged client usage batch    | [#8267](https://github.com/LionSR/TeXRA/pull/8267) | Open draft |
| `P0.1`     | Validate usage batches atomically and mark permanent rejection | [#8270](https://github.com/LionSR/TeXRA/pull/8270) | Open draft |
| `P0.2`     | Omit diagnostics when a host has no linter                     | [#8271](https://github.com/LionSR/TeXRA/pull/8271) | Merged     |
| `P0.4`     | Require explicit persistent or ephemeral transcript stores     | [#8287](https://github.com/LionSR/TeXRA/pull/8287) | Open draft |
| `P0.10`    | Fail closed when ignore policy cannot be read or applied       | [#8272](https://github.com/LionSR/TeXRA/pull/8272) | Merged     |
| `P0.11`    | Preserve unreadable or invalid resumable flow state            | [#8277](https://github.com/LionSR/TeXRA/pull/8277) | Open draft |
| `P0.12`    | Remove automatic delete-and-replace on circular symlinks       | [#8276](https://github.com/LionSR/TeXRA/pull/8276) | Merged     |
| `P0.13`    | Refuse approval when current proposed content is unreadable    | [#8275](https://github.com/LionSR/TeXRA/pull/8275) | Merged     |
| `P2.1`     | Keep one desktop project-configuration source after failures   | [#8237](https://github.com/LionSR/TeXRA/pull/8237) | Merged     |

The two `P0.1` pull requests form one protocol change and should be reviewed
and merged together. The server marks only permanent payload rejection as
non-retryable; the client retries every other unacknowledged batch with its
original identifier.

The next implementation order is governed by data loss and coupling, not by
source order:

1. `P0.3` durable JSON corruption, building on the merged read-only `JsonStore`
   opening work in #8237.
2. Review `P0.4` in #8287: explicit persistent versus ephemeral transcript
   construction removes nondurable production runs and method-level lifecycle
   checks.
3. `P0.7` and `P0.8` terminal metadata and flush outcomes, designed together so
   completion and durability have one observable owner.
4. `P0.5` diagnostic snapshot reads, before further persisted-schema cleanup.
5. `P0.6` a three-state secrets contract, before adding more credential routes.
6. `P0.9` unknown completion and invalid tool-call evidence, split by provider
   protocol so each change remains reviewable.

## Executive finding

TeXRA does not have one general "fallback problem." It has four distinct kinds
of fallback, and treating them uniformly would make the system less reliable:

1. **False-fact fallbacks** turn corruption, an unavailable capability, or an
   unsuccessful operation into a valid-looking success. These should be removed.
2. **Partial-initialization fallbacks** permit production objects to exist in an
   invalid state and then compensate with no-ops. These should be replaced by
   constructors or factories that establish a valid state.
3. **Compatibility fallbacks** support old persisted or cross-version data.
   These should be isolated behind one reader, measured, and given a deletion
   trigger. They should not remain in ordinary write paths or UI components.
4. **Bounded recovery fallbacks** handle a genuinely optional value, a missing
   cache, or an unavailable presentation surface. These are useful when absence
   is distinguished from failure and the selected path remains observable.

The highest-impact defects are not the most numerous ones. The most serious are:

- missing relay enforcement credentials disabling spending, rate, and
  concurrency gates while requests continue;
- a missing signup-hook secret selecting unsigned production handling;
- missing or malformed device-approval intent becoming approval;
- unavailable spending data becoming zero spend for paid tiers;
- malformed usage acknowledgements being accepted as successful;
- unavailable diagnostics being reported as an empty diagnostic set;
- malformed durable JSON being replaced by `{}` and later overwritten;
- transcript stores silently dropping writes when not opened;
- invalid persisted work-plan and usage fields becoming valid defaults;
- credential access failures being treated as missing credentials and permitting
  alternate-provider routing;
- terminal execution metadata being persisted on a best-effort basis although it
  is the source of truth for resumability;
- sidecar/transcript flushes resolving after their writes fail;
- missing provider completion state being synthesized as `completed` or `stop`;
  and
- unreadable ignore rules becoming "ignore nothing," which can admit files that
  the user intended to exclude from model context.

These findings are P0 because they can lose durable data, lose accounting data,
misreport a capability, or change authentication/provider behavior. They should
precede cosmetic cleanup of nullish defaults and presentation fallbacks.

The detailed list contains 48 prioritized findings: four fail-open security
gates (`P0.S*`), 13 further P0 integrity findings, 26 P1 ownership/coupling
findings, and five P2 cleanup findings. The family register additionally records
the bounded fallbacks that should remain.

## Census and method

The audit first enumerated syntax that can select an alternate value or path,
then inspected the semantic owner and downstream use. The source set contains
1,612 production files. The raw candidate census is:

| Candidate form                                                      | Count | Files |
| ------------------------------------------------------------------- | ----: | ----: |
| Explicit `fallback`, `legacy`, `best effort`, or equivalent markers |   930 |   N/A |
| Nullish coalescing (`??`)                                           | 2,436 |   713 |
| Logical OR operator                                                 | 1,811 |   613 |
| Default parameters                                                  |   580 |   304 |
| `catch` clauses                                                     |   771 |   367 |
| Non-throwing `catch` clauses                                        |   635 |   311 |
| `catch` clauses that return without rethrowing                      |   298 |   185 |
| `safeParse` calls                                                   |   129 |    81 |
| Method calls named `.catch(...)`                                    |   262 |   150 |
| Silent non-throwing-catch heuristic                                 |   210 |   132 |
| Empty `catch` clauses                                               |    61 |    42 |
| Zod `.prefault(...)` calls                                          |   255 |    48 |

The explicit-marker row is a heuristic union rather than one syntactic form, so
a unique file count is not meaningful. The rows overlap. They are a candidate
universe, not a defect count. For example, `value ?? defaultValue` is correct
when `value` is genuinely optional, and many `.catch(...)` calls are promise
cleanup or schema normalization at an external boundary.

Three independent source passes covered:

- core runtime, persistence, transcript, model, authentication, telemetry, and
  tools;
- the VS Code extension host and its webviews; and
- CLI, desktop, Supabase functions, scripts, and remaining root modules.

Each candidate family was judged by five questions:

1. Does it distinguish **missing**, **invalid**, **unavailable**, and **failed**?
2. Is the default a true domain value, or does it invent a fact?
3. Is the data authoritative durable state, reconstructible cache, or local
   presentation state?
4. Is fallback provenance visible to the caller and logs?
5. Is the fallback owned at the boundary where the uncertainty enters?

## Priority scale

- **P0:** Can silently lose durable/accounting data, misroute credentials, or
  report false success. Blocks further architecture migration.
- **P1:** Creates cross-layer coupling, invalid lifecycle states, or broad error
  masking that repeatedly causes host drift.
- **P2:** Compatibility or configuration debt with bounded present-day impact.
  Tighten after the P0/P1 ownership fixes.
- **Keep:** A bounded, typed, and observable recovery path whose alternative is
  genuinely equivalent for the caller.

## Prioritized findings

### P0.S1 Missing relay enforcement credentials disable all request gates

**Pins.** `supabase/functions/relay/index.ts:117-126` constructs no admin client
when `SUPABASE_SERVICE_ROLE_KEY` is absent and explicitly states that requests
will still be served. Monthly spending enforcement is conditional at `:625-656`;
rate and concurrency enforcement is independently conditional at `:780-824`.

**Complexity and risk.** One missing deployment secret disables three independent
cost and abuse controls while the relay continues forwarding authenticated
requests with server-side provider keys. The checks are written as optional
features even though they are invariants of the relay service.

**Before:**

```ts
const adminClient = serviceRoleKey ? createClient(serviceRoleKey) : null;
if (adminClient) await enforceSpendingAndRequestGates();
await forwardWithServerKey();
```

**After:** Validate required environment at cold start. If service-role access is
unavailable, the relay should fail initialization or return `503` for every
key-bearing request. Public metadata routes may remain available through a
separate handler that does not forward provider requests.

**Disposition:** Resolved on main by [#8269](https://github.com/LionSR/TeXRA/pull/8269).
Remove the fail-open configuration path before other fallback work.

### P0.S2 Missing signup-hook secret permits unsigned hook handling

**Pins.** `supabase/functions/before-user-created/index.ts:23-28` represents a
missing `BEFORE_USER_CREATED_HOOK_SECRET` as `webhook = null`. At `:113-132`,
signature verification is then skipped and the request is allowed with only a
warning.

**Complexity and risk.** Authenticity is a deployment invariant, not an optional
enhancement. The request handler contains two operational modes with materially
different trust assumptions, selected by a missing environment variable.

**After design.** Validate the secret during cold start and reject requests with
`503` until configured. Development should use an explicitly selected local
adapter or emulator, not the production handler's missing-secret branch.

**Disposition:** Resolved on main by [#8268](https://github.com/LionSR/TeXRA/pull/8268).
Remove unsigned production mode.

### P0.S3 Missing or malformed device-approval intent means approval

**Pins.** `supabase/functions/auth-device/index.ts:237-256` parses an arbitrary
JSON object and computes `const approve = body?.approve !== false`. Any absent,
null, string, number, or object value except literal `false` approves the device
code.

**Complexity and risk.** Approval is a security decision. Treating every value
other than one exact denial sentinel as consent is fail-open parsing.

**Before:**

```ts
const approve = body?.approve !== false;
```

**After:** Parse a strict schema containing `approve: z.boolean()` and reject
missing or malformed intent with `400`. Approval and denial should both require
an explicit boolean.

**Disposition:** Draft implementation: [#8266](https://github.com/LionSR/TeXRA/pull/8266).
Remove the implicit-approval fallback.

### P0.S4 Spending-check failure becomes zero spend for paid tiers

**Pins.** `supabase/functions/relay/index.ts:364-416` logs an RPC error, constructs
zero current spend, and allows non-free tiers. The same path accepts database data
through numeric coercion/defaults before comparing it with limits.

**Complexity and risk.** A database outage and a verified zero balance are
different states. The current policy is documented as protecting paying users
from transient failures, but it is implemented by inventing accounting data. That
makes the grace policy unbounded and difficult to audit.

**After design.** Validate finite nonnegative spend and return `verified` or
`unavailable`. If paid tiers require a grace mode, define an explicit bounded
allowance using last-verified spend, an expiry, a maximum request/cost budget, and
metrics. Never report unavailable spend as zero.

**Disposition:** Resolved on main by [#8269](https://github.com/LionSR/TeXRA/pull/8269).
Remove synthetic zero; preserve availability only through an explicit grace
policy.

### P0.1 Usage telemetry accepts malformed protocol data as success

**Pins.** `src/telemetry/UsageLogService.ts:136-182` parses a server response with
`UsageLogResponseSchema.catch({ success: true, accepted: batch.entries.length })`.
`supabase/functions/log-usage/index.ts:285-294` skips invalid entries and may
return success after accepting none. At `:65-84`, an invalid
`viaChatGptSubscription` value becomes `false`.

**Complexity and risk.** A protocol failure is translated into the strongest
possible acknowledgement: every queued entry is accepted. The client then
removes the batch. The server also applies field-level recovery independently,
so neither side has one authoritative account of accepted and rejected entries.
This is an accounting-integrity defect, not resilience.

**Before:**

```ts
const response = UsageLogResponseSchema.catch({
  success: true,
  accepted: batch.entries.length,
}).parse(data);
removeAcceptedBatch(response.accepted);
```

**After:**

```ts
const response = UsageLogResponseSchema.parse(data);
if (!response.success) throw new UsageUploadError(response);
commitAcceptedEntries(response.acceptedIds);
quarantineRejectedEntries(response.rejections);
```

The server should either reject a malformed batch atomically with an explicit
permanent-rejection payload, or return accepted identifiers and structured
rejection reasons. During the #8270/#8267 rolling deployment, that payload uses
HTTP 200 so older clients read it instead of throwing before the body; #6981
owns restoring HTTP 422 after those clients age out. The client should retain or
quarantine every entry not explicitly acknowledged. Missing legacy fields may
use `.prefault(...)`; invalid present fields must not use `.catch(...)`.

**Disposition:** Draft implementations: [#8267](https://github.com/LionSR/TeXRA/pull/8267)
and [#8270](https://github.com/LionSR/TeXRA/pull/8270), deployed server first.
Remove the success fallback.

### P0.2 Unavailable diagnostics are reported as an empty successful result

**Pins.** `src/agent/runtime/HostInteractions.ts` makes diagnostics an optional
session capability. `src/tools/DiagnosticsTool.ts` requires the active
session's `readDiagnostics` interaction and throws a capability error when it
is absent instead of returning `status: 'executed'` with an empty list.
The CLI deliberately keeps diagnostics `list` and `count` available while hiding
only `diagnostics.add` (`packages/cli/src/runtime/unavailableTools.ts:25-36`).
Desktop applies the same capability split in
`packages/desktop/src/main/desktopAgentExecution.ts:119-126`.

**Complexity and risk.** "The host cannot collect diagnostics" and "the file has
zero diagnostics" are different facts. The optional port erases that distinction
inside a domain tool, so models and users receive a false clean result. Every host
must remember an undocumented relationship between tool registration and an
optional platform field.

**Before:**

```ts
const messages = (await platform().linter?.(path)) ?? [];
return executed(count(messages));
```

**After:**

```ts
const linter = currentSession().interactions.readDiagnostics;
if (!linter) throw unavailable('diagnostics.read');
return executed(count(await linter(path)));
```

Either provide a host-neutral linter for CLI and desktop, or omit the read
capability from their tool roster. `diagnostics.add` must likewise distinguish
"unsupported" from "supported but disabled."

**Disposition:** Resolved on main by [#8271](https://github.com/LionSR/TeXRA/pull/8271);
the capability subsequently moved from the process-wide Platform object to the
active session interaction adapter in #8508. The empty-result fallback remains
removed.

### P0.3 Durable JSON corruption is converted to an empty store

**Pins.** `src/platform/defaults/jsonStore.ts:41-61,86-95` defaults to
`strict: false`; malformed JSON is logged and replaced by `{}`. A subsequent
update writes that empty snapshot over the original file. Non-strict consumers
include desktop and CLI global/workspace state, desktop configuration, desktop
secrets, and desktop stream snapshots. Only CLI secrets explicitly request
strict parsing.

**Complexity and risk.** The storage primitive cannot know whether its contents
are disposable cache or authoritative settings and credentials. Its permissive
default therefore imposes one destructive corruption policy on unrelated data.
Callers see a valid empty record and cannot warn, recover, or preserve evidence.

**Before:**

```ts
try {
  return JSON.parse(raw);
} catch (error) {
  log(error);
  return {};
}
```

**After:**

```ts
const store = await JsonStore.open(path, {
  corruptionPolicy: 'fail',
  schema: GlobalStateSchema,
});
```

Use an explicit policy such as `'fail'` or `'quarantine-and-reset'`; do not
default it. A reset policy must first preserve the raw file under a quarantine
name and report the recovery. Cache-only callers may opt into reset. Durable
settings and secrets should fail until repaired.

**Disposition:** Remove the implicit `{}` fallback. #8220/#8237 cover read-only
opening and #8222/#8238 cover concurrent read-modify-write; neither resolves
corruption policy.

### P0.4 `StreamLogStore` has a production-reachable invalid lifecycle state

**Pins.** `src/transcript/StreamLogStore.ts:405,427,578,590` silently skips
operations while `loaded` is false. The guard exists partly because tests create
the store without loading it. CLI launch paths duplicate compensating behavior:
`packages/cli/src/runtime/runExecution.ts:231-243` and
`packages/cli/src/chat/tui/runChatTui.tsx:404-415` continue in memory after load
failure.

**Complexity and risk.** Construction does not establish the store's invariant.
Every method must therefore defend against an unopened object, while hosts add a
second fallback around opening. A headless run can appear successful while its
transcript is not durable.

**Before:**

```ts
const store = new StreamLogStore(path);
await store.load();
await store.save(); // silently returns if load was omitted or failed
```

**After:**

```ts
const transcript = await StreamLogStore.open(path); // always persistent
// or
const transcript = StreamLogStore.ephemeral(reason); // explicit distinct type
```

Make partially initialized construction private. A durable headless run should
fail when persistence cannot open unless the caller explicitly selects an
ephemeral mode. Interactive hosts may continue with `ephemeral(reason)`, but must
display that state.

**Disposition:** Draft implementation: [#8287](https://github.com/LionSR/TeXRA/pull/8287).

### P0.5 Invalid persisted snapshots become valid empty/current snapshots

**Pins.** `src/shared/schemas/streamSnapshot.ts:73-100` applies catches to the
schema version, todos, plan, and summary. `src/transcript/streamSnapshotRead.ts:
139-156` catches the whole schema to an empty snapshot. In
`src/shared/schemas/streamData.ts:120-159`, malformed numeric usage fields become
zero and invalid subscription provenance becomes false.

**Complexity and risk.** A future schema version, a missing legacy field, and a
corrupt present field all converge on one current valid object. The repaired
object may later be persisted, destroying the only evidence needed for recovery.
For usage, zero is a real value and therefore cannot represent parse failure.

**Before:**

```ts
const snapshot = SnapshotSchema.catch(EMPTY_SNAPSHOT).parse(raw);
```

**After:**

```ts
const result = readSnapshot(raw);
// { kind: 'current', value }
// { kind: 'legacy', value, migrations }
// { kind: 'future' | 'corrupt', raw, diagnostics }
```

Use `.prefault(...)` only for absent fields with documented legacy meaning.
Invalid present fields should preserve the raw record and produce diagnostics.
Extend the existing top-level "preserve unparsed usage" approach to individual
usage fields and work plans.

**Disposition:** Replace defaulting with a diagnostic read result. Coordinate
status-field retirement with #7993 and legacy removal with #6981.

### P0.6 Credential access failure is treated as credential absence

**Pins.** The secrets port returns only a value, `undefined`, or an exception
(`src/platform/secrets.ts`). Desktop decryption/keychain failures return
`undefined` after warning (`packages/desktop/src/main/platform/electronSecrets.ts:
77-108`). `src/model/computeModelOptions.ts:120-141` treats read errors as an
absent key and can then expose an OpenRouter fallback. Profile construction in
`src/controllers/settingsView/ProfileMessageBuilder.ts:74-117` similarly turns
auth/tier/agent failures into signed-out, free, personal, or empty states.

`src/tools/externalToolDefs.ts:587-591` and
`src/tools/github/githubAuth.ts:27-37` also bypass the host boundary with direct
environment-variable fallback.

**Complexity and risk.** Missing credentials are ordinary input; unavailable
credential storage is an operational failure. Conflating them can change the
provider selected for a request and therefore its billing, privacy, and policy
surface. The view also presents false account facts.

**Before:**

```ts
const key = await secrets.get(name).catch(() => undefined);
return key ?? alternateProviderKey();
```

**After:**

```ts
type SecretLookup =
  | { kind: 'found'; value: string }
  | { kind: 'missing' }
  | { kind: 'unavailable'; error: Error };
```

Alternate credentials or providers may be considered only for `missing`.
`unavailable` should block the operation or present a degraded state. Environment
resolution belongs in each host's `PlatformSecrets` implementation, not core
tools.

**Disposition:** Tighten to a three-state secrets contract. The recently fixed
stale Codex relay fallback (#8218) is one instance; it does not settle the wider
contract.

### P0.7 Terminal execution metadata uses best-effort persistence

**Pins.** `src/agent/storage/executionLifecycle.ts:144-168` documents terminal
status as the source of truth but implements `persistMetaField` as a logger that
never throws. `src/agent/runtime/AgentRunLifecycle.ts:88-132` adds another catch
and continues. Flow-record cleanup is independently swallowed in
`src/agent/implementations/flows/reflection/runReflectionFlow.ts:366-373` and
`src/agent/implementations/flows/tooluse/runToolUseFlow.ts:549-565`.

**Complexity and risk.** Completion status, output retention, and resumability
are one lifecycle decision, but three owners persist or delete pieces with
independent failure policies. The caller cannot know whether an apparently
completed run is durably complete or will be repaired/resumed after restart.

**Before:**

```ts
await persistMetaField(...); // logs and returns on failure
await deleteFlowRecord(...).catch(log);
return result;
```

**After:**

```ts
const persistence = await executionLifecycle.finalize({
  executionId,
  terminalStatus,
  outcome,
  flowRetention,
});
return { result, persistence };
```

One storage facade should own the terminal transaction and return a typed
`PersistenceOutcome`. Runtime finalization may continue after failure, but the
failure must be emitted once as a durable-state warning. Flow implementations
should not own record deletion.

**Disposition:** Centralize and make failure observable. This implements the
ownership described in
[`2026-06-10-lifecycle-status-ownership.md`](./2026-06-10-lifecycle-status-ownership.md).

### P0.8 Transcript and snapshot durability APIs resolve after failed writes

**Pins.** `src/transcript/StreamSnapshotStore.ts:1129-1161` starts a detached
write, logs rejection, and exposes `flushWritesForStream()` as waiting only for
mutex release. It cannot report whether the write succeeded. Deferred mutations
also log and disappear after seed failure at `:473-493`.
`src/transcript/StreamLogStore.ts` re-marks failed writes dirty for retry, but
save/flush waiters do not receive a durability result.

**Complexity and risk.** Callers use "flush completed" as a synchronization fact,
while stores define it as "no write is currently holding the lock." The latter is
not a persistence guarantee. Recovery differs between the two stores, and neither
contract exposes the difference.

**Before:**

```ts
void mutex.runExclusive(write).catch(log);
await mutex.waitForUnlock(); // resolves after success or failure
```

**After:**

```ts
const outcome = await sidecars.flush(streamId);
// { kind: 'durable' }
// { kind: 'pending-retry', failures }
// { kind: 'failed', failures }
```

Store each in-flight write promise and its result, not only its mutex. Deferred
mutations must remain queued after a recoverable seed failure or return a rejected
mutation to the caller. Reuse `StreamLogStore`'s preserved-raw/write-barrier
pattern, while making its retry state visible.

**Disposition:** Tighten all transcript/sidecar flush contracts before relying on
them for shutdown or restart repair.

### P0.9 Unknown completion state is synthesized as successful completion

**Pins.** `src/tools/executionFormatters.ts:53-64` labels an execution
`completed` when neither a live handle nor persisted terminal status exists.
`src/agent/modelHandlers/openai/BaseReasoningStreamAggregator.ts:79-110,155-159`
defaults missing provider choices and finish reasons to `stop`.
`src/agent/modelHandlers/openai/modelHandlerOpenAI.ts:864-869` makes the same
assumption for a direct response fallback. At `:1075-1082`, unserializable tool
arguments become `{}`.

**Complexity and risk.** `completed`, `stop`, and an empty argument object are
valid protocol values. They cannot also represent missing evidence. These
fallbacks can hide truncation, display an active/failed execution as complete, or
invoke a tool with arguments the model did not supply.

**Before:**

```ts
status = terminalStatus ?? 'completed';
finishReason = response.finish_reason ?? 'stop';
argumentsJson = serialize(arguments).catch(() => '{}');
```

**After:**

```ts
status = terminalStatus ?? 'unknown';
finishReason = response.finish_reason ?? 'unknown';
if (!argumentsJson.ok) return invalidToolCall(argumentsJson.error);
```

The model result type should preserve `incomplete/unknown` and prohibit tool
execution after argument serialization or parsing failure. Only an explicit
provider completion fact may become `stop`.

**Disposition:** Remove success-valued protocol fallbacks.

### P0.10 Unreadable ignore rules become "ignore nothing"

**Pins.** `src/tools/gitignore.ts:33-42` turns every ignore-file read error into
absence. Matcher errors return `false` at `:123-133`; outer construction failure
logs a warning and returns `EMPTY_GITIGNORE_MATCHER` at `:138-144`.

**Complexity and risk.** A missing `.gitignore` legitimately means no rules.
An existing but unreadable or unparseable ignore file means the intended file
selection policy is unknown. Treating it as no rules can include credentials,
generated data, or private files in model context. Logging does not undo that
selection.

**Before:** Ignore-policy failure selects every file.

**After:** Return `loaded`, `absent`, or `unreadable`. For `unreadable`, fail the
context-building operation or require an explicit caller policy that excludes
uncertain paths. Matcher failure should fail closed for that path and report the
rule source.

**Disposition:** Resolved on main by [#8272](https://github.com/LionSR/TeXRA/pull/8272).
Remove fail-open behavior at the model-context boundary.

### P0.11 Unreadable or invalid resumable flow state is deleted and restarted

**Pins.** `src/agent/implementations/flows/tooluse/runToolUseFlow.ts:376-402`
logs a failed read as "starting fresh"; invalid migrated shared state is deleted.
`src/agent/implementations/flows/reflection/runReflectionFlow.ts:200-254`
likewise deletes a present record that fails validation and constructs round-zero
state.

**Complexity and risk.** Confirmed absence, unreadable storage, unsupported future
data, and malformed current data all select a fresh run. Deleting the record makes
the decision irreversible. The new run reuses an execution identity whose prior
conversation and side effects may already exist, so "start over" is not a neutral
fallback.

**Before:**

```ts
const record = await read().catch(() => null);
if (!migrate(record)) await deleteRecord();
return createFreshState();
```

**After:**

```ts
const state = await readFlowState();
// absent -> create fresh state
// valid -> resume
// legacy -> migrate, preserve source
// unreadable/unsupported -> quarantine and require repair or explicit restart
```

An explicit restart should allocate or record a new attempt and preserve the old
record for diagnosis. Automatic fresh start is valid only for confirmed absence.

**Disposition:** Draft implementation: [#8277](https://github.com/LionSR/TeXRA/pull/8277).
Remove destructive recovery from both flow runners and place the policy in the
persistence/resume facade.

### P0.12 Circular-symlink write failure triggers automatic destructive repair

**Pins.** `src/utils/files/flexibleFS.ts:55-80` catches `ELOOP`, recursively
deletes the path without trash, and replaces it with a regular file.

**Complexity and risk.** Detecting a circular symlink is reliable; deciding to
destroy it is policy. The filesystem abstraction silently combines both. A caller
that requested a write did not necessarily authorize topology repair or deletion
of a path that may be managed outside TeXRA.

**Before:** Every `FlexibleFS.write` implicitly authorizes delete-and-replace on
`ELOOP`.

**After:** Return a typed circular-link error. A narrowly named repair operation
may delete and replace only after the owning workflow explicitly selects that
policy and records the affected path. Prefer preserving or renaming the link for
diagnosis.

**Disposition:** Resolved on main by [#8276](https://github.com/LionSR/TeXRA/pull/8276).
Remove destructive behavior from the general write primitive.

### P0.13 Diff approval falls back to stale proposed content

**Pins.** `packages/extension/src/frontend/approval/VscodeDiffViewHost.ts:124`
uses the original proposed-content value when the proposed document is closed and
reading its current bytes fails.

**Complexity and risk.** Approval is meant to authorize the content currently
shown or edited by the user. A failed read changes that object to an earlier copy,
so approval can discard user edits while still appearing to succeed.

**Before:** `current proposed bytes ?? original fallback bytes` are accepted by
the same action.

**After:** Return `contentUnavailable` and disable approval until current bytes
can be read. If recovery offers the original proposal, it must open it as a new
explicit review revision rather than substituting it under the existing approval.

**Disposition:** Resolved on main by [#8275](https://github.com/LionSR/TeXRA/pull/8275).
Remove stale-content approval fallback.

### P1.1 Process output read failures are swallowed before the logger can see them

**Pins.** `src/agent/runtime/ProcessOutputPoller.ts:213-237` wraps both stdout and
stderr reads with `.catch(() => '')`. The surrounding catch claims to report
persistent read failures, but these inner catches make that path unreachable.

**Before:**

```ts
await Promise.all([
  readTail(stdout).catch(() => ''),
  readTail(stderr).catch(() => ''),
]);
```

**After:**

```ts
const [stdout, stderr] = await Promise.allSettled([
  readTail(stdoutPath),
  readTail(stderrPath),
]);
```

Preserve a successful channel. Ignore only a documented `ENOENT` creation/deletion
race; report other failures per stream.

**Disposition:** Tighten catches by error class.

### P1.2 One-shot onboarding migration writes permanent facts from failed probes

**Pins.** CLI, extension, and desktop independently catch credential/history
probe failures and convert them to `false` in
`packages/cli/src/onboarding/runOnboarding.tsx:129-159`,
`packages/extension/src/extension.ts:320-349`, and
`packages/desktop/src/main/index.ts:797-836`. They then call
`backfillFirstRunDone`, which writes a one-time marker
(`src/controllers/onboarding/onboardingFunnel.ts:136-159`).

**Complexity and risk.** A transient inability to inspect prior state becomes a
permanent statement that prior state did not exist. The same policy is duplicated
across three hosts, so corrections amplify across the codebase.

**After design.** Move probing into a shared service that returns `yes`, `no`, or
`unknown` with reasons. Write the migration marker only when every required probe
is known. Hosts should own presentation, not evidence interpretation.

**Disposition:** Remove false-on-error; centralize the migration policy.

### P1.3 Core runtime asks a process-global UI bridge whether a view is visible

**Pins.** `src/agent/runtime/ProgressViewBridge.ts:14-26` contains a global bridge
whose default returns false. `src/agent/runtime/executeAgent.ts:441-447` queries
that UI state. Extension and desktop register different global implementations.

**Complexity and risk.** Runtime behavior depends on UI initialization order and
process-global state. Missing registration looks like a hidden view rather than a
composition error. New hosts must reproduce a UI concept that should not exist in
the execution layer.

**Before:** Runtime queries `isViewVisible()` and conditionally emits.

**After:** A root run always emits `requestEnsureProgressView`; each host handles
the request idempotently according to its own visible/open/notification state.
Delete `ProgressViewBridge` and its default.

**Disposition:** Move the decision upward to host presentation. This is an SDK
blocker under #7724.

### P1.4 `HostInteractions` is optional even where runtime operations require it

**Pins.** `src/agent/runtime/HostInteractions.ts:159-206` makes seven methods
optional and installs `noopHostInteractions`. `src/agent/runtime/AgentRuntimeHost.ts:
29-39` also permits an optional/no-op interaction object. Bash approval, user
questions, external inquiry, planning, proposal, retry, and tool-edit paths then
repeat runtime checks for methods that are required for their operation.

**Complexity and risk.** Missing composition and an intentional headless denial
have the same representation. Optionality leaks from the composition root into
every tool, while the no-op object lets wiring omissions survive until a distant
branch executes.

**After design.** Bind a total interaction policy when constructing a
`SessionHandle`. A headless host should provide explicit implementations that
return denied/unavailable outcomes. If capabilities truly differ, expose a
discriminated capability set and omit incompatible tools before execution.

**Disposition:** Remove the no-op production default. Coordinate approval-state
ownership with #8144.

### P1.5 Runtime `tryPlatform()` calls hide composition and test seams

**Pins.** `src/platform/platform.ts:98-106` says `tryPlatform()` is intended for
module-level initialization, yet runtime call sites include Codex auth/preference,
subagent detachment policy, configuration setters, GitHub auth, desktop state,
desktop file selection, and settings IPC. Particularly severe examples are:

- `src/utils/config/providerConfig.ts`: updates can silently do nothing;
- `packages/desktop/src/main/desktopAgentExecution.ts:269`: memory persistence
  appears when platform state is unavailable;
- `packages/desktop/src/main/desktopSettingsIpc.ts:224`: `emptySecrets` is used;
- `packages/desktop/src/main/desktopSettingsIpcHelpers.ts:13-20`: secret set and
  delete operations report success while discarding data.

**Complexity and risk.** A bootstrap-order escape hatch has become an ambient
service locator with local defaults. Production code and tests can run through
different storage, filesystem, and authentication implementations without the
type system showing the difference.

**After design.** Restrict `tryPlatform()` to bootstrap, shutdown, and deliberate
module-initialization probes. Runtime code should use `platform()` or constructor
dependencies. Tests should install explicit memory implementations. Add an import
or lint boundary once migrations are complete.

**Disposition:** Remove runtime fallbacks, especially successful no-op writes.

### P1.6 Invalid stored settings collapse to permissive ordinary defaults

**Pins.** `src/shared/config/settingsAccess.ts:49-66` returns a schema default for
invalid raw settings. `src/shared/schemas/agentCliSettings.ts:10-19` catches
invalid enum members. Codex approval and sandbox settings then use ordinary
defaults (`'never'` and `'workspace-write'`) through
`src/tools/support/enumConfig.ts`.

**Complexity and risk.** Missing settings need defaults; invalid present settings
need diagnosis. Treating both alike can silently weaken a user's intended safety
policy and makes malformed configuration impossible to find from behavior.

**After design.** Use `.prefault(...)` for absent values. Invalid security-related
values should fail closed or block launch with a precise diagnostic. Other invalid
settings may use a documented default only after emitting one central warning.

**Disposition:** Tighten parse contracts by sensitivity.

### P1.7 External-inquiry history has a multi-layer masking chain

**Pins.** `src/tools/inquiry/externalInquiryStorage.ts:871-885` maps every
directory-read error to an empty list. Hydration in
`src/controllers/progressView/backend/externalInquiryHydration.ts:33-110`
swallows history synchronization failures and skips malformed manifests. A
comment claims damage is logged, but the list operation does not log it.

**Complexity and risk.** Missing history, inaccessible history, and corrupt
history all render identically. Storage and projection layers each suppress a
different part of the same failure, so no owner can report a complete degraded
state.

**After design.** Only `ENOENT` means an empty history. Storage should return
entries plus structured read failures; hydration should return applied/skipped
identifiers and diagnostics. The progress backend should present one degraded
history warning.

**Disposition:** Tighten by error class and give reporting one owner.

### P1.8 Broad filesystem catches turn I/O failure into absence

**Pins.** Representative production sites include:

- `src/utils/files/baseFS.ts:47-55,180-213`: the shared `exists`, `isDir`,
  `isFile`, and `isSymbolicLink` predicates map every error to `false`;
- `src/agent/output/compiledPdfArtifacts.ts:84-87`: any `stat` error means absent;
- `src/tools/glob.ts:98-99`: any `stat` error gives mtime zero;
- `src/agent/storage/executionWorkspaceFiles.ts:52-55`: any `stat` error omits a file;
- `packages/cli/src/runtime/history/generatedFiles.ts:48`: any error gives size zero;
- `src/latex/latexdiff/outputDiscovery.ts:60,123`: a symlink-check error becomes
  `false`.

**Complexity and risk.** Permission, path traversal, transient I/O, and absence
have different safety consequences. The latexdiff case can proceed as though an
uncertain path were known not to be a symlink.

Because `BaseFS` is shared, its policy is the first fix: callers currently cannot
recover error detail after the predicate erases it.

**After design.** Reuse the pattern in
`src/common/storage/KVStore.ts:27-37`: fall back only for a recognized file-not-
found error. Propagate other errors or return a degraded diagnostic. Symlink
uncertainty should fail closed.

**Disposition:** Tighten catches systematically with `isFileNotFoundError`.

### P1.9 Compatibility inference runs in ordinary resume and UI paths

**Pins.** The principal families are:

- `src/transcript/executionStreamResolver.ts:113-184`: canonical metadata, then
  an O(N) metadata scan, suffix guesses, and caller fallback;
- `src/agent/runtime/modelHandlerCompatibilityInference.ts`: provider handler
  inferred from message shape;
- `src/agent/runtime/AgentLaunchContext.ts:180-203`: failed flow reads can fall
  through to route inference;
- `src/agent/implementations/flows/tooluse/runToolUseFlow.ts:433-450`:
  launch-time repair for a leftover flow without a resume snapshot;
- `packages/extension/src/webview/MainViewProvider.ts:233-242`: producer dual-writes
  `optionsData` and `optionsDataByCategory`;
- `src/shared/schemas/mainView/outbound.ts:21-30` and
  `packages/extension/src/webview/frontend/slices/catalogSlice.ts:70-87`: the UI
  accepts and resolves both shapes; and
- extension progress rendering in
  `packages/extension/src/progressView/frontend/slices/logSlice.ts` and
  `packages/extension/src/progressView/frontend/components/messageIndex.ts`
  translates legacy statuses, synthesizes missing group starts, and re-roots
  dangling parents inside browser state.

**Complexity and risk.** Compatibility policy is distributed across storage,
runtime routing, host message production, and UI projection. New writes continue
to carry old shapes, so telemetry cannot show when the old reader is unused and
the compatibility branch has no natural deletion point.

**Before:** Every consumer guesses when canonical data is missing or unreadable.

**After:** A versioned boundary reader returns canonical data plus migration
provenance, then writes canonical metadata once. Current writes contain only the
current shape. Read failure is not equivalent to a missing legacy field.
Trace/replay compatibility belongs in a versioned decoder before the progress
store; renderers should receive canonical events only.

**Disposition:** Isolate and retire under #6981/#6984. Status vocabulary work
belongs with #7993. Add any unledgered compatibility family to #6981 before
extending it.

### P1.10 UI components infer business roles and availability

**Pins.** `packages/extension/src/settingsView/frontend/tabs/MultiAgentTab.ts:
236-243` guesses orchestrators from name substrings when registry data is absent.
`packages/extension/src/progressView/ProgressViewProvider.ts:257-283` silently
substitutes a basic model list or omits an agent selector after backend failure.
Settings and main-view code also choose the first available provider/option when
an authoritative selection is unavailable.
`packages/extension/src/settingsView/frontend/settingsState.ts:84`,
`packages/extension/src/settingsView/frontend/components/profile/providerKeyRows.ts:9`,
and
`packages/extension/src/progressView/frontend/components/StreamTabs.ts:345`
add renderer-owned defaults such as free, personal, all keys unset, and stream
`READY`. `catalogSlice.ts` and `mainViewActions.ts` also apply legacy-name,
preferred-agent, first-enabled-model, first-entry, and empty-entry selection
chains in browser state.

**Complexity and risk.** Business meaning is reconstructed from labels in the
view layer. Backend failure therefore changes agent classification and model
availability rather than producing an unknown/degraded state.

**After design.** Hosts should send complete role/capability data in a
discriminated `ModelOptionsResult` and `loading | ready(snapshot) |
degraded(error)` state envelopes. A shared host/core selection resolver should
return the canonical selection and reason. Views render those states and never
infer roles, access, stream readiness, or provider policy from names/order.

**Disposition:** Move policy upward to the catalog/model layer; keep only visual
placeholder defaults in the view.

### P1.11 Authentication and entitlement failures become ordinary free/empty state

**Pins.** `src/auth/config.ts:57-62` catches malformed permissions to `[]` and
tier to `free`; `src/auth/relayToken.ts:50-54` repeats the tier default.
`src/auth/SupabaseClient.ts:314-332` returns empty/free contexts for several
non-valid states. Tier, server-key, and profile controllers add further
null/empty/default layers before the result reaches model availability.
The extension adds a second translation: validation/network exceptions become
"no sessions" in `packages/extension/src/frontend/auth/SupabaseAuthProvider.ts:
190`, while session-removal failure is swallowed near `:478` and the command can
still report successful sign-out.

**Complexity and risk.** A genuinely free account, a signed-out account, an
unverifiable token, an unavailable profile service, and corrupt saved auth data
can be indistinguishable. Each layer adds its own default, so the final UI and
model router cannot state why access is absent or whether retry is appropriate.

**Before:** `UserAuthContext = { permissions: [], tier: 'free' }` is both a domain
value and the universal error value.

**After:** Return `authenticated`, `signed-out`, `denied`, or `unavailable`, with
the last state carrying degraded fields and an error. One boundary schema should
own compatibility defaults. Downstream availability must consume that state
rather than catch it again.

**Disposition:** Tighten to a provenance-bearing auth state. Keep refresh-token
and legacy-claim fallbacks where they are bounded and fail closed. Report sign-out
success only after confirmed local removal.

### P1.12 Model and credential route selection is only partially centralized

**Pins.** `src/model/runModelDecision.ts:1-81` centralizes model-name precedence
and records `fallbackFrom`, which is a sound base. However, provider and credential
selection is re-derived in `src/model/computeModelOptions.ts`,
`src/agent/runtime/ModelFactory.ts`, model handlers, helper-model resolution, and
progress follow-up/retry controllers. Some callers request `fallbackMode:
'silent'`, for example `ProgressFollowUpController.ts:263-281`.

**Complexity and risk.** The selected model name does not determine the credential
source, endpoint, subscription route, or reason. Availability can therefore be
computed under one route and execution/retry under another. A retry may mutate a
persistent preference even though the failure was session-local.

**Before:** Each layer selects one part of `{ model, provider, credential,
endpoint }` and locally substitutes another candidate.

**After:** Deepen `RunModelDecision` into a `ModelRouteDecision` that carries the
model, handler compatibility key, provider, credential source, endpoint, reason,
and fallback provenance. Availability, launch, follow-up, and retry should pass
the same immutable decision. Session failures may create an explicit session
override; they should not silently mutate user preferences.

**Disposition:** Consolidate route policy without adding another parallel router.
This should follow the secret-state fix in P0.6.

### P1.13 Output recovery loses source and confidence information

**Pins.** `src/agent/output/lineageMapping.ts` may select the first basename
match; `src/agent/output/diffComputation.ts` turns diff failure into an empty
result; `src/agent/output/snapshotResolution.ts` can substitute the live file for
a missing snapshot; and reflection `OutputNode` paths can return an empty output
set after repeated extraction failure. `src/agent/output/XmlOutputManager.ts`
contains a useful but broad cascade of XML, regex, heading, fence, legacy, and
similarity extraction methods.

**Complexity and risk.** These fallbacks recover useful output, but the result
type does not consistently preserve which source or heuristic produced each file.
An ambiguous basename can select the wrong file, while unavailable diff data can
look like "no changes."

**After design.** Return source and confidence with every recovered artifact:
`canonical`, `legacy`, `live-file`, or `heuristic(method, confidence)`. Require a
unique basename match. Represent diff as `computed`, `unavailable`, or `failed`.
Low-confidence file assignment should require confirmation rather than writing.

**Disposition:** Keep the tested extraction cascade, but tighten ambiguity and
make provenance part of the output contract.

### P1.14 Failed plan retarget leaves a contradictory autonomous goal active

**Pins.** `src/tools/plan/PlanTool.ts:344-386` tries to retarget an in-flight
goal after the user approves a new plan. On failure it returns an explicit error,
but states that the previous goal remains active and will continue injecting
continuations for its old objective.

**Complexity and risk.** Error reporting is correct, but the fallback execution
state is not. Turn-by-turn work follows the newly approved plan while the
autonomous controller follows the old plan. The user has one stream with two
contradictory objectives.

**After design.** Make retarget transactional: pause the old goal first, update
the objective, then reactivate it. If update fails, leave the goal paused and
return the explicit error. A new autonomous goal should not start until ownership
of the prior one is settled.

**Disposition:** Tighten the recovery state; do not continue with two active
policies.

### P1.15 Signup policy treats unavailable evidence as an exemption

**Pins.** `supabase/functions/before-user-created/index.ts:134-165` allows
signups when email is absent, a GitHub login is absent, or GitHub account-age
lookup is unavailable/rate-limited. The code cannot distinguish a deliberate
anonymous-signup exemption from missing policy evidence.

**Complexity and risk.** Network probing and admission policy are fused in the
HTTP handler. Availability is preserved by turning `unknown` into `allowed`, so
the policy's effective strength depends on GitHub availability.

**After design.** The probe should return `eligible`, `ineligible`, `not-
applicable`, or `unavailable`. Policy should explicitly decide which providers
are exempt and whether unavailable evidence is retried, queued for review, or
rejected. A bounded availability exception should be measured and time-limited.

**Disposition:** Tighten evidence handling; do not encode exemption as a failed
lookup.

### P1.16 Tool detection and execution resolve different commands

**Pins.** `src/utils/system/toolUtils.ts:219-281` returns `false` immediately
when the bare executable cannot run, before consulting `BinaryResolver`. When a
fallback path is successfully probed, only a boolean is returned. Later,
`runToolWithCheck` executes the original bare name at `:343-352`.

**Complexity and risk.** Discovery throws away its most important result: the
resolved command. Probe success therefore does not imply execution success, and
the same fallback search is inconsistently applied.

**After design.** Replace boolean detection with
`resolveTool(): ResolvedCommand | Unavailable`. Use the same command, arguments,
environment, source, and version for both probe and execution.

**Disposition:** Deepen the resolver and delete boolean/path duplication.

### P1.17 LaTeX compiler fallback overstates build success

**Pins.** `src/latex/latexToolchain.ts:38-68` reports XeLaTeX or LuaLaTeX as a
usable compiler, while `src/latex/texTools.ts:190-230` executes only `latexmk`
or `pdflatex`. If `latexmk` is missing, compilation falls back to one
`pdflatex` pass; a successful process becomes `{ ok: true }` even though the log
warns that bibliography, cross-references, and indexes may be incomplete.

**Complexity and risk.** Probe policy and execution policy name different
capabilities. The fallback also collapses "PDF process exited successfully" and
"document build is complete."

**After design.** One compiler resolver should return an executable build plan.
The result should be `complete`, `degraded(reason)`, or `failed`. Support XeLaTeX
and LuaLaTeX in execution or stop advertising them as sufficient.

**Disposition:** Keep the useful single-pass fallback, but make it explicit and
non-success-equivalent.

### P1.18 Latexdiff fallback changes semantic scope

**Pins.** `src/latex/latexdiff/runLatexdiff.ts` can fall from pinned run outputs
to workspace scanning. Desktop then converts a shared-core error, no resolved
rounds, or all failed operations to a single current-file diff in
`packages/desktop/src/main/desktopProgressFileActions.ts:146-160`.

**Complexity and risk.** These alternatives answer different questions. A run-
scoped comparison and a current-workspace comparison are not interchangeable,
but the caller receives whichever can be produced.

**After design.** Return `run-diff`, `workspace-diff-available`, or `failed` with
source paths. Changing from pinned run artifacts to current files requires an
explicit user action or caller policy.

**Disposition:** Remove implicit semantic-scope substitution.

### P1.19 Display-only proposal defaults can become executable input

**Pins.** `src/shared/schemas/proposalInput.ts:1-23,39-55` describes defaults for
display reconstruction, including a default model and empty file lists. The same
reconstructed proposal backs the progress view's Setup action, which can replay
it into the main view.

**Complexity and risk.** Presentation recovery and executable validation share
one type. Values invented so an old log can render may therefore become launch
parameters.

**After design.** Parse old logs into a `ProposalDisplayProjection` with unknown
fields preserved. Setup must convert through a strict executable proposal schema
and require the user to fill every unknown required field.

**Disposition:** Split display projection from executable input.

### P1.20 Unknown build architectures default to x64

**Pins.** `scripts/desktop-codex-payload.mjs:358-382` maps any unrecognized
native architecture to x64 on a non-arm64 host and defaults unknown Linux/Windows
targets to x64.

**Complexity and risk.** Build target uncertainty becomes a valid artifact label.
The package can be produced successfully with an incompatible native payload and
fail only after distribution.

**After design.** Accept only an enumerated architecture or a path token verified
against the packaged binary. Reject unsupported/unknown targets during packaging.

**Disposition:** Remove x64 as a universal architecture fallback.

### P1.21 Missing desktop file confirmation means consent

**Pins.** `packages/desktop/src/main/desktopProgressFileActions.ts:121-136`
makes the confirmation callback optional and substitutes `Promise.resolve(true)`
when absent. Production currently supplies the callback, but the adapter contract
is fail-open.

**Complexity and risk.** A composition omission authorizes replacement of a user
file. The overwrite primitive cannot tell explicit consent from missing wiring.

**After design.** Make confirmation required in the interactive adapter. A
headless policy must be explicitly named and should default to rejection unless
the caller supplies an approved noninteractive mode.

**Disposition:** Remove implicit consent before another desktop composition path
is added.

### P1.22 Extension migration is marked complete after partial write failure

**Pins.** `packages/extension/src/frontend/setup.ts:489-503` catches failure
while writing individual legacy LaTeX settings, then still records the migration
as complete.

**Complexity and risk.** A transient write failure becomes permanent missing
state because the one-shot gate suppresses every later retry. Completion is owned
by the outer loop, which cannot represent per-key outcomes.

**After design.** Use a versioned migration result containing every applicable
key and its `migrated`, `already-current`, or `failed` outcome. Mark the migration
complete only when no unresolved key remains. Retrying must be idempotent.

**Disposition:** Remove unconditional completion.

### P1.23 Git probe failure changes extension storage authority

**Pins.** `packages/extension/src/frontend/git/resolveGitRoot.ts:40` maps Git,
stat, read, and parse failures to `undefined`. The state manager at
`packages/extension/src/common/state/stateManager.ts:48` interprets that value as
no repository and selects ordinary workspace state instead of worktree-shared
state.

**Complexity and risk.** An infrastructure probe decides persistence scope. A
transient Git failure can therefore split state between two authorities and make
settings appear to revert between launches.

**After design.** Return `repository(root)`, `notRepository`, or `probeError`.
Only the confirmed `notRepository` result may select workspace-local state;
`probeError` should preserve the existing authority or block writes.

**Disposition:** Remove error-to-no-repository equivalence.

### P1.24 Terminal execution can return a nominal but unobservable result

**Pins.** `packages/extension/src/frontend/setupTerminalRunner.ts:27-94` sends
text when shell integration is absent but returns empty output, unknown exit code,
and `timedOut: false`. Stream failure and drain timeout can also become empty
output.

**Complexity and risk.** "Command was sent" is represented using the same result
shape as an observed execution. Callers can infer completion or success from the
absence of timeout/error even though no exit status was available.

**After design.** Return `observed(result)`, `unobserved(reason)`, `timedOut`, or
`failed`. Operations requiring output or completion must reject `unobserved`;
fire-and-forget setup actions may present it explicitly.

**Disposition:** Tighten the terminal port contract.

### P1.25 Progress events infer stream identity and repair ordering in the view

**Pins.** `packages/extension/src/progressView/frontend/slices/followUpSlice.ts:
45` sends a transcription without a stream identifier to the currently active
tab. `streamMetaSlice.ts:32` buffers descriptions in module state because stream
registration may arrive later.

**Complexity and risk.** The browser reconstructs event correlation from mutable
focus and arrival order. A delayed event can be attached to the wrong stream, and
module-local buffering creates an undocumented second event queue.

**After design.** Require stream identity at the host event boundary and order
registration before dependent facts. A bounded ingress buffer may remain only for
versioned legacy events; it should be keyed, observable, and expire explicitly.

**Disposition:** Remove active-tab inference and move ordering repair out of view
state.

### P1.26 Pending state restore silently drops queued work

**Pins.** `packages/extension/src/commands/history/stateRestoreCommand.ts:53`
reports/continues through in-memory queuing when the webview is unavailable.
`packages/extension/src/common/state/pendingStateManager.ts:8` caps the queue at
ten and silently removes the oldest entry.

**Complexity and risk.** The command has no result that distinguishes applied,
queued, and discarded. An activation/lifecycle workaround therefore behaves like
durable state restoration but is only bounded process memory.

**After design.** Return `applied`, `queued`, or `rejected`; make overflow an
explicit rejection. If restore must survive view activation or restart, persist
the intent under one owner and acknowledge it only after application.

**Disposition:** Tighten queue semantics and surface loss.

### P2.1 Desktop project configuration silently changes storage location

**Pins.** `packages/desktop/src/main/platform/index.ts:105-127` falls back from a
project configuration file to an internal hidden workspace configuration after
read/open failure.

**Complexity and risk.** A transient error creates a second writable source of
truth. Later launches may alternate between stores, making values appear to
revert.

**After design.** Distinguish "project configuration absent" from "project
configuration inaccessible/corrupt." Absence may select a documented default
location. Failure should put configuration into a visible degraded read-only
state until repaired.

**Disposition:** Resolved on main by [#8237](https://github.com/LionSR/TeXRA/pull/8237),
which selects the configuration source once and preserves that choice after
read or migration failures.

### P2.2 External binary search may select a protocol-incompatible PATH version

**Pins.** `src/tools/support/externalBinaryUtils.ts:108-146` uses PATH as its last
search strategy and notes that the binary may be older than the SDK-compatible
version.

**Complexity and risk.** Path existence is treated as compatibility. Downstream
failures then appear as tool protocol defects rather than a selected fallback
binary.

**After design.** Return `{ path, source, version }`, validate the supported
version/protocol range, and accept PATH only when compatible. Include the selected
source in diagnostics.

**Disposition:** Keep discovery fallback, tighten compatibility validation.

### P2.3 Invalid tool definitions are normalized to minimal valid definitions

**Pins.** `src/tools/registry.ts:193-223` catches an invalid definition and
returns a minimal `{ name }` object. Agent loading and remote-agent loading then
operate on a definition that no longer reflects the user's input.

**Complexity and risk.** Validation is delayed until the registry and recovery
silently discards fields. The error cannot be attributed to the originating YAML
or remote record, and tools may run with unintended defaults.

**After design.** Validate and normalize at the agent-definition boundary, with
source locations and diagnostics. The registry should accept only canonical tool
definitions.

**Disposition:** Remove registry-level schema catch.

### P2.4 Relay scope and preset parsing drop invalid present data

**Pins.** `packages/cli/src/runtime/relayTokensClient.ts:13-18` catches invalid
scope data to `['relay']`; `src/shared/schemas/agentPresets.ts:56-64` silently
drops malformed presets. Similar field-level catches occur in non-security UI
state schemas.

**Complexity and risk.** A compatibility default for a missing field is also used
for an invalid present field. This hides contract drift and makes partial data
loss look intentional.

**After design.** Use `.prefault(...)` for fields absent in a documented old
version. Invalid present scopes should reject the response. Preset loaders should
return valid presets plus diagnostics for rejected records.

**Disposition:** Tighten parsing; preserve partial recovery only with diagnostics.

### P2.5 Extension consumers repeat defaults after boundary validation

**Pins.** Representative sites include
`packages/extension/src/frontend/review/AgentReviewService.ts:238`,
`packages/extension/src/webview/managers/FileManager.ts:187`, and
`packages/extension/src/webview/frontend/slices/documentSlice.ts:122`. They add
local defaults such as `fileType: input`, `isGitRepo: true`, and `HEAD` after
configuration or IPC parsing.

**Complexity and risk.** The boundary schema and consumer become competing
authorities. A new producer field or changed product default must be updated in
multiple hosts/views, and missing required canonical data continues silently.

**After design.** Normalize each value once in the shared configuration or IPC
schema. Consumers should receive complete canonical values; absence of a required
field is a boundary error. Keep only visual defaults that do not change behavior.

**Disposition:** Delete repeated consumer literals as their canonical schema is
made complete.

## Complete fallback-family register

The table below records the semantic families found in the candidate census. It
is the completeness boundary of this audit: individual `??`, `||`, and default
parameters are grouped by the uncertainty they represent, not listed as thousands
of mechanically identical rows.

| Layer / family                      | Representative locations                         | Present behavior                                                           | Decision                                                 |
| ----------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Relay deployment enforcement        | Supabase relay                                   | Missing admin credential skips spend/rate/concurrency controls             | **Fail unavailable (P0.S1)**                             |
| Signup-hook authenticity            | before-user-created function                     | Missing secret accepts unsigned handling                                   | **Fail unavailable (P0.S2)**                             |
| Device approval parsing             | auth-device function                             | Any value except literal false approves                                    | **Strict explicit boolean (P0.S3)**                      |
| Spend-check availability            | Supabase relay                                   | RPC failure becomes zero and paid-tier allow                               | **Explicit bounded grace (P0.S4)**                       |
| Signup eligibility evidence         | before-user-created function                     | Missing/unavailable evidence becomes allowed                               | **Typed policy decision (P1.15)**                        |
| Telemetry acknowledgement           | `UsageLogService`, Supabase `log-usage`          | Invalid response/entry becomes success or omission                         | **Remove (P0.1)**                                        |
| Durable JSON corruption             | `platform/defaults/jsonStore`                    | Malformed JSON becomes `{}`                                                | **Remove (P0.3)**                                        |
| Durable-store concurrency           | `JsonStore.update`                               | Stale snapshot may overwrite concurrent keys                               | **Fix via #8222/#8238**                                  |
| Read-only store opening             | `JsonStore.open`, CLI secrets                    | Read requires directory mutation                                           | **Fix via #8220/#8237**                                  |
| Transcript not opened               | `StreamLogStore` and CLI callers                 | Writes/flush silently no-op or become memory-only                          | **Remove (P0.4)**                                        |
| Transcript/sidecar write failure    | `StreamLogStore`, `StreamSnapshotStore`          | Flush can resolve without a durable write                                  | **Expose durability (P0.8)**                             |
| Snapshot schema recovery            | `streamSnapshot`, `streamSnapshotRead`           | Corrupt/future data becomes empty/current                                  | **Replace with diagnostic result (P0.5)**                |
| Usage field recovery                | `streamData`, normalized usage schemas           | Invalid numeric/provenance fields become zero/false                        | **Tighten (P0.5)**                                       |
| Terminal lifecycle persistence      | `executionLifecycle`, flow cleanup               | Authoritative writes are best effort                                       | **Centralize (P0.7)**                                    |
| Flow-state recovery                 | reflection/tool-use flow runners                 | Invalid/unreadable state is deleted and restarted                          | **Remove (P0.11)**                                       |
| Execution status display            | `executionFormatters`, execution tools           | Missing terminal fact becomes completed                                    | **Use unknown (P0.9)**                                   |
| Extension one-shot migration        | extension setup                                  | Failed key writes still mark migration complete                            | **Per-key outcomes (P1.22)**                             |
| Missing-file storage reads          | `KVStore.withMissingFallback`                    | Only recognized absence becomes empty/default                              | **Keep**                                                 |
| Broad filesystem absence            | artifact, glob, history, latexdiff helpers       | Any I/O failure becomes missing/zero/not-symlink                           | **Tighten (P1.8)**                                       |
| Circular-symlink repair             | `FlexibleFS.write`                               | `ELOOP` deletes and replaces the path                                      | **Remove from primitive (P0.12)**                        |
| Run-mirror source selection         | task-run storage                                 | Snapshot stat failure selects live workspace source                        | **Only ENOENT; preserve source**                         |
| Optional host diagnostics           | `DiagnosticsTool`, CLI/desktop rosters           | Unsupported becomes empty success                                          | **Remove (P0.2)**                                        |
| Optional host interactions          | `HostInteractions`, `AgentRuntimeHost`           | Missing composition becomes no-op/unavailable deep in tools                | **Replace (P1.4)**                                       |
| Runtime UI visibility               | `ProgressViewBridge`, `executeAgent`             | Missing bridge defaults to hidden                                          | **Move to host (P1.3)**                                  |
| Platform-before-init                | Codex auth, config, desktop runtime/settings     | Missing platform becomes false, memory, Node FS, or no-op writes           | **Remove from runtime (P1.5)**                           |
| Git-probed state authority          | extension Git/state managers                     | Probe error selects workspace-local instead of shared state                | **Typed probe (P1.23)**                                  |
| Credential source chain             | platform secrets, model options, external tools  | Read failure can act like missing and select another source                | **Three-state contract (P0.6)**                          |
| Environment-variable credentials    | GitHub/external tool helpers                     | Core bypasses host secrets port                                            | **Move to host (P0.6)**                                  |
| Account/profile projection          | `ProfileMessageBuilder`                          | Failed probes become free/personal/signed-out/empty                        | **Render degraded state (P0.6)**                         |
| Auth/tier schema recovery           | auth config, relay token, Supabase client        | Invalid/unverifiable state becomes free with no permissions                | **Typed auth state (P1.11)**                             |
| Session/token compatibility         | Supabase and Codex session readers               | Legacy tokens, claim names, and callback ports are tried                   | **Keep; add provenance/unreadable state**                |
| Security configuration parsing      | settings access, agent CLI settings              | Invalid present value becomes ordinary default                             | **Fail closed or block (P1.6)**                          |
| Ordinary optional configuration     | Zod `.prefault`, default parameters              | Missing value gets documented product default                              | **Keep**                                                 |
| Tool-definition parsing             | tool registry                                    | Invalid definition becomes `{ name }`                                      | **Remove (P2.3)**                                        |
| Partial list parsing                | agent presets, manifests                         | Invalid members are dropped                                                | **Keep only with diagnostics (P2.4)**                    |
| Onboarding evidence probes          | all three hosts                                  | Probe error becomes false and is persisted once                            | **Centralize tri-state (P1.2)**                          |
| Process output polling              | `ProcessOutputPoller`                            | Read failure becomes empty text                                            | **Tighten (P1.1)**                                       |
| Unobserved terminal execution       | extension setup terminal                         | Sent text returns nominal empty/no-timeout result                          | **Typed observation (P1.24)**                            |
| Provider completion normalization   | OpenAI aggregators/handlers                      | Missing finish reason becomes `stop`; usage can become zero                | **Preserve unknown (P0.9)**                              |
| Tool argument serialization         | OpenAI handler                                   | Serialization failure becomes `{}`                                         | **Reject tool call (P0.9)**                              |
| Media/attachment degradation        | model handlers and attachment tools              | Unreadable/oversized inputs become metadata or are dropped                 | **Keep; report omitted IDs/mode**                        |
| Context compaction/token estimation | model handlers                                   | Failed compaction keeps history; counting may estimate/cap                 | **Keep bounded recovery; expose estimate quality**       |
| External-inquiry history            | storage and hydration                            | Read/corruption failures become empty/skipped                              | **Tighten and centralize (P1.7)**                        |
| Execution stream resolution         | `executionStreamResolver`                        | Scans and guesses identifiers                                              | **Isolate, measure, retire**                             |
| Model-handler inference             | compatibility inference, launch context          | Message shape substitutes for canonical metadata                           | **Legacy-only reader; retire**                           |
| Tool-use leftover repair            | `runToolUseFlow`                                 | Launch repairs an unexpected partial migration                             | **Measure; remove after trigger**                        |
| Main-view IPC dual shape            | provider, outbound schema, catalog slice         | Producer and consumer both carry old/new fields                            | **Stop dual writes; retire via #6981**                   |
| Lifecycle status aliases            | shared schemas and UI readers                    | Invalid/legacy states collapse to current defaults                         | **Finish #7993, then delete**                            |
| Legacy trace reconstruction         | progress slices/message index                    | Browser synthesizes groups and repairs parentage                           | **Versioned ingress decoder**                            |
| Progress event correlation          | progress frontend slices                         | Missing stream uses active tab; order repaired in module state             | **Fix at host boundary (P1.25)**                         |
| Agent role inference                | settings webview                                 | Name substring substitutes for registry fact                               | **Remove from UI (P1.10)**                               |
| Model/agent option loading          | progress/settings views                          | Failure becomes a smaller ordinary list                                    | **Use unavailable state (P1.10)**                        |
| CLI model registry loading          | orchestrate command                              | Registry failure becomes empty and may launch default model                | **Block launch as unavailable**                          |
| Model and credential routing        | model decision, factory, handlers, retries       | Layers independently substitute route components                           | **One route decision (P1.12)**                           |
| Retired/unknown model metadata      | model option registry/state                      | Registry order/defaults make unknown models look runnable                  | **Explicit unknown/unresolved state**                    |
| Provider capability inference       | provider capabilities                            | Model-name/date heuristics stand in for registry facts                     | **Keep as measured compatibility data**                  |
| Helper-model selection              | helper preference/runtime                        | Stale/unavailable helper becomes selected/first model                      | **Use shared route decision**                            |
| UI selection defaults               | first provider/model/tab, absent optional labels | Chooses a local visual selection                                           | **Keep only when data is valid and nonempty**            |
| Presentation placeholders           | icons, labels, elapsed text, widths              | Missing cosmetic data gets neutral rendering                               | **Keep**                                                 |
| TUI terminal degradation            | color, table width, BEL, non-TTY paths           | Uses less rich but visible presentation                                    | **Keep**                                                 |
| Preview/diff opener chain           | desktop/extension openers                        | Embedded viewer failure opens an external surface                          | **Keep: visible and logged**                             |
| Diff approval content               | extension diff host                              | Read failure substitutes stale proposal                                    | **Block approval (P0.13)**                               |
| File-replacement confirmation       | desktop progress actions                         | Missing callback means consent                                             | **Require/fail closed (P1.21)**                          |
| External binary discovery           | bundled, configured, PATH                        | Last path may be incompatible                                              | **Keep search; validate version (P2.2)**                 |
| Tool detection/execution            | shared tool utils                                | Resolver result becomes boolean; bare name executes                        | **Return resolved command (P1.16)**                      |
| LaTeX compiler fallback             | LaTeX toolchain and compiler                     | Single-pass PDF is reported as complete build                              | **Degraded result (P1.17)**                              |
| Latexdiff source scope              | core and desktop diff paths                      | Run diff failure becomes workspace/current-file diff                       | **Require explicit scope change (P1.18)**                |
| Model-output extraction             | JSON/XML/text parsing cascades                   | Tries documented alternate encodings                                       | **Keep with parse provenance**                           |
| Output lineage and snapshot source  | output lineage/diff/snapshot modules             | First basename/live file/empty diff can look authoritative                 | **Require source/confidence (P1.13)**                    |
| YAML parsing                        | `safeParseYaml` and callers                      | Returns a result instead of inventing data                                 | **Keep**                                                 |
| JWT/claim probing                   | auth boundary                                    | Optional claim names are tried; auth still fails closed                    | **Keep**                                                 |
| SDK/provider error inference        | common SDK error inspection                      | Class, text, status, headers, and body provide competing evidence          | **Rank evidence with confidence**                        |
| Gitignore loading/matching          | `tools/gitignore`                                | Unreadable rules mean ignore nothing                                       | **Fail closed (P0.10)**                                  |
| Agent catalog scanning              | registry/scanner/remote loader                   | Source/list failure becomes an empty catalog                               | **Return per-source error state**                        |
| Goal retarget recovery              | `PlanTool`                                       | New plan proceeds while old autonomous goal remains active                 | **Pause transactionally (P1.14)**                        |
| Generic node retry                  | flow node base                                   | Configuration may retry errors without a transient classification          | **Default to normalized transient errors only**          |
| Text-connection inference           | runtime text connection                          | Failed/invalid model decision inserts a space                              | **Return unknown; caller decides**                       |
| Legacy configuration aliases        | JSON config and file-list settings               | Ordered aliases remain writable and ambiguous                              | **Normalize once; retain read compatibility**            |
| Workspace storage migration         | workspace storage defaults                       | Old/new directories and shared sentinel can collide                        | **Migration marker and conflict policy**                 |
| Desktop project configuration       | desktop platform composition                     | Read/open failure selects a hidden writable configuration store            | **Only absence selects the default (P2.1)**              |
| Completed-run archive recovery      | transcript archive                               | Mtime/order/unknown defaults choose among sidecars                         | **Generation IDs and preserved invalid rows**            |
| Prompt/resource fallback            | goal prompt and agent creator                    | Inline duplicate or validated template replaces missing AI/resource output | **Generate/checksum duplicate; keep validated template** |
| Proposal log reconstruction         | proposal input schema                            | Display defaults can be replayed as executable fields                      | **Separate strict input (P1.19)**                        |
| Build architecture inference        | desktop payload script                           | Unknown target becomes x64                                                 | **Reject unknown (P1.20)**                               |
| Pending restore queue               | extension history/state                          | Apparent success queues in memory; overflow drops oldest                   | **Typed result/durable owner (P1.26)**                   |
| Post-boundary consumer defaults     | extension host/webviews                          | Consumers repeat behavioral IPC/config defaults                            | **Normalize once (P2.5)**                                |
| Cleanup after completion            | temp files, already-removed records, disposals   | Best-effort cleanup after authoritative outcome                            | **Keep if limited to ENOENT/noncritical cleanup**        |
| Optional telemetry/audit decoration | timestamps, identity linking                     | Auxiliary enrichment can be omitted with logs                              | **Keep if primary event remains intact**                 |
| Network/source cache fallback       | GitHub, Zotero, arXiv, web tools                 | Local/cache/manual data replaces remote response                           | **Keep with source, freshness, and quality**             |
| Array/map/string defaults           | empty collections, labels, local formatting      | Represents genuine optional local data                                     | **Keep**                                                 |
| Numeric clamps and render defaults  | percentages, dimensions, counters                | Prevents invalid presentation geometry                                     | **Keep at presentation boundary**                        |

## Structural rules for tightening fallbacks

### 1. Missing is not invalid

Use `.prefault(...)`, `??`, or a default parameter only when absence has a
documented meaning. A present value that fails validation should produce a parse
error or diagnostic result.

```ts
const Schema = z.object({
  oldOptionalField: z.string().prefault('legacy-default'),
  securityMode: SecurityModeSchema, // invalid present value is an error
});
```

### 2. Unsupported is not empty

Capability APIs should return an unavailable result or omit the operation from
the advertised surface. Empty arrays and `false` are domain values, not generic
capability sentinels.

### 3. Durable state is not a cache

Authoritative state must fail, preserve raw data, or enter an explicit degraded
mode. Automatic reset belongs only to reconstructible caches, and should still be
observable.

### 4. Recovery should be a boundary operation

Legacy normalization belongs in one versioned reader. UI components, flow nodes,
and storage writers should consume and produce only the current representation.

### 5. A fallback needs provenance and a deletion rule

An alternate provider, binary, stream identifier, or schema route should report
which route was selected. Compatibility paths should have a counter and a removal
condition in #6981/#6984. Without observation, "temporary" code is permanent.

### 6. No-op implementations must be explicit policies

An intentional headless policy may deny interaction or choose ephemeral storage.
It should be named and injected. An ambient default that silently discards writes
or approvals is a composition defect.

## Recommended implementation order

1. **Close fail-open security gates:** require relay enforcement and hook
   credentials, strict-parse device approval, and replace synthetic zero spend
   with an explicit bounded policy.
2. **Protect data and accounting:** fix usage acknowledgement, `JsonStore`
   corruption policy, snapshot parsing, write/flush outcomes, and terminal
   persistence.
3. **Prevent false execution facts:** preserve unknown completion/finish state,
   reject invalid tool arguments, stop destructive flow restart, and fail closed
   when ignore policy is unreadable.
4. **Make capabilities truthful:** fix diagnostics, secrets tri-state, auth state,
   and security-setting parsing.
5. **Eliminate invalid object states:** replace unopened `StreamLogStore`, total
   the runtime interaction policy, and remove successful no-op storage adapters.
6. **Move decisions to their owner:** remove `ProgressViewBridge`, centralize
   onboarding probes, and move role/model availability out of UI components.
7. **Narrow broad catches:** process polling, inquiry history, and filesystem
   helpers should distinguish `ENOENT` from operational failure.
8. **Retire compatibility paths:** stop dual writes, migrate canonical metadata,
   instrument legacy reads, and delete each path when #6981/#6984 triggers fire.
9. **Leave bounded presentation defaults alone:** avoid churn in local rendering,
   optional labels, collection defaults, and visible external-viewer fallbacks.

Items 1-5 should be implemented as small, independently testable changes. A
single repository-wide replacement of catches or nullish operators would destroy
useful recovery behavior and obscure the integrity fixes.

## Issue mapping

For the current remediation batch, the implementation ledger above is the
focused tracking surface for findings that already have draft pull requests.
Unscheduled findings remain under #7726 and should receive a child issue when
implementation is scheduled, avoiding a second open tracker beside an active
pull request.

| Existing issue   | Use in this audit                                                      |
| ---------------- | ---------------------------------------------------------------------- |
| #7726            | Parent tracker for false-success and broad masking chains              |
| #6981            | Ledger for legacy readers and producer/consumer dual shapes            |
| #6984            | Age/telemetry-based deletion gate for compatibility paths              |
| #7993            | Remaining extension/shared lifecycle-status readers                    |
| #8144            | Session ownership of approval queues and interaction state             |
| #7724            | SDK boundary; motivates truthful total host capabilities               |
| #8220 / PR #8237 | Read-only `JsonStore` opening and directory mutation                   |
| #8222 / PR #8238 | Serialized/merged `JsonStore` updates                                  |
| #8218            | Closed narrow stale-Codex-relay fallback; broader secret state remains |

New focused issues are warranted for P0.S1-P0.S4 and P0.1-P0.13 where an
existing focused issue does not already own the mechanism. Closely coupled
storage findings may share an issue only when one implementation can restore one
durability contract. They should link to #7726 where applicable and describe the
false fact or destructive transition being created, not merely the catch or
default that implements it.

## Verification expectations

Each removal or tightening should add a test for the distinction it restores:

- missing versus malformed durable data;
- unsupported capability versus a valid empty result;
- missing credential versus unavailable credential store;
- accepted versus rejected telemetry entries;
- persistent versus explicit ephemeral transcript mode;
- `ENOENT` versus permission/I/O failure; and
- legacy absent metadata versus unreadable current metadata.

The desired endpoint is not zero fallbacks. It is a codebase in which every
fallback has one owner, a narrow input condition, an observable result, and, for
compatibility code, a deletion date or measurable trigger.

The audit was read-only apart from this report. Relevant tests were inspected to
determine intended compatibility and recovery behavior, but no automated test
suite was executed because no production code changed.
