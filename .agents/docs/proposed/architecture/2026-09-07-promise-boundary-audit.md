# Promise-boundary audit: every `Effect.tryPromise` and `Effect.promise` in production

Status: proposed

Every production `Effect.tryPromise` and `Effect.promise` site is classified
here as a **legitimate foreign edge** or a **Promise-typed surface that has
not been converted yet**, so the migration lanes of
[2026-08-26-effect-4-runtime-migration.md](./2026-08-26-effect-4-runtime-migration.md)
can be aimed at the second set and stop worrying about the first.

The audit answers a question that keeps recurring in review: is wrapping a
promise inside an Effect program a smell? The short answer is **no at a
foreign edge and yes over our own code**, and the two are not distinguishable
by counting call sites — only by looking at what is on the other side of each
wrap. That is what this note does, once, for all 98 of them.

## 1. Method

```bash
grep -rn 'Effect\.tryPromise\|Effect\.promise' --include=*.ts src packages
```

147 raw matches. Excluded: 45 in `src/test-kernel/**` and `*.vitest.ts`
(test doubles, fake timers, and `vi.waitFor` bridges — not production
boundaries), and 4 prose mentions inside comments. **98 production sites
remain: 82 `Effect.tryPromise`, 16 `Effect.promise`.** Each was read at its
call site and its callee traced to its defining module to decide whether the
wrapped promise is foreign or ours.

_Rebased onto `main` at b28e981._ The tree now holds **86** sites (73
`tryPromise`, 13 `promise`). Eleven of the twelve went in this branch's own
work (§9): two `Effect.promise` sites converted in `ExecutionsTool`, four
duplicate wrapper declarations deleted, five inline copies of the same wrapper
folded into it. The twelfth went upstream —
`SessionEvents.ts:329`, the `runWithWorkspaceRoots(transcripts.readEntries)`
wrap, which the SQLite event plane (#11978) removed. It was a C2b site and one
of §5.2's ambient-context crossings, so both counts drop by one below. Line
numbers throughout this note predate that rebase; see §8.

## 2. The rule this audit applies

A wrap is legitimate exactly when **the thing on the other side will never be
an Effect**. `fetch`, `node:fs`, `ky`, `tar`, `proper-lockfile`, `clipboardy`,
a `vscode` LSP client, an Electron IPC handler — none of these will ever
return an `Effect`, and `Effect.tryPromise` is how they enter. Effect's own
platform packages are built out of it. There is no more-native alternative,
and R1 already names these as the destination rather than debt.

A wrap is debt when the promise is **ours** — a repo-owned `async function`
that could carry an Effect signature. Four things are lost at every wrap, and
they are the diagnostic:

1. **Interruption stops at the wrap.** `Effect.tryPromise` creates an
   `AbortSignal` only when the callback _declares the parameter_. Ten of the
   98 sites do; the other 88 are uninterruptible bodies — fiber interruption
   returns while the promise keeps running. This is the same debt the
   `new AbortController(` row of the effect-migration ratchet tracks, seen
   from the other side.
2. **The error type is invented, not inherited.** A native Effect propagates
   its own typed failures; a wrap collapses everything into whatever the
   `catch` mapper decides, and every call site decides again.
3. **Requirements cannot flow.** `R` is always `never` through a promise, so
   anything the inner code needs is captured in a closure instead of being a
   service — which is how ambient `AsyncLocalStorage` context survives
   (category B3, §5.2).
4. **Tracing and span continuity break** across the wrap.

**Direction matters more than count.** `Effect.tryPromise` is _entry_
(Promise → Effect) and is unbounded — a growing Effect surface produces more
of them at the rim. `Effect.runPromise` is _exit_ (Effect → Promise) and is
the real debt marker, because it means the caller above is still
Promise-typed. `scripts/check-effect-migration-ratchet.mjs` counts only
`Effect.run*`, and only below R1's three boundary kinds. **That asymmetry is
correct, and this audit does not propose changing it** — see §6.

## 2.5 Can the foreign edges use Effect-native modules instead?

Asked directly: the A1 sites wrap `node:fs`, `ky`/`fetch`, and `execa`. Effect
ships native counterparts — `FileSystem`, `HttpClient`, `Command`. Should they
replace the wraps?

**Not without an owner decision, and the constraint is the repository's own.**
Against `effect@4.0.0-rc.112` as installed:

- `effect/FileSystem` is a **stable top-level module, but a tag only**. It
  exports the `FileSystem` service tag, `make`, `makeNoop`, and `layerNoop` —
  a testing stub. There is no Node-backed layer in core; every real
  implementation is consumed from `effect/unstable/*` or a platform package
  that is not a dependency here.
- `HttpClient` lives at `effect/unstable/http`.
- The process/command API lives at `effect/unstable/process`.

So all three replacements require `effect/unstable/*`, and the migration PRD
gates that twice: **non-goal 4** ("No adoption of `effect/unstable/*` modules
in the foundation phases") and **§11** ("No `effect/unstable/*` import enters
without a separate decision naming its replacement or exit plan"), with the
RC-churn risk row naming "stable modules only" as its mitigation.

That is a live decision, not a closed one — an RC-pinned repository that
already tracks Effect closely may well want `FileSystem` and `HttpClient`. But
it is the kind of decision the PRD reserves, and it would arrive with real
consequences: an `HttpClient` swap changes retry, timeout, and redirect
semantics that `ky` currently owns per call site, and a `FileSystem` layer has
to be provided at all three host runtimes. Adopting either as a side effect of
a boundary audit would be exactly the "wrapper-only adoption" the risk table
warns about.

Recommended: raise it as its own note under `.agents/docs/proposed/`, scoped to
one module (`FileSystem` is the strongest candidate — it is the one whose tag
is already stable, and §F3's sixteen sites are the ones that would benefit).
Until then the A1 wraps stay, and they are correct.

## 3. Taxonomy and counts

| Category                                                        | Sites         | Verdict                                              |
| --------------------------------------------------------------- | ------------- | ---------------------------------------------------- |
| **A1** Foreign runtime or library edge                          | 28            | Permanent and correct                                |
| **A2** Host-port edge (Promise-typed port)                      | 13            | Correct while the port is Promise-typed              |
| **B1** Named generic wrapper (one per subsystem)                | 13 → 9        | 9 are real policy; 4 were duplicates, collapsed (§9) |
| **B2** Repo-owned promise API, re-wrapped at call sites         | 26            | **Debt** — the conversion targets                    |
| **B3** Ambient-context (`AsyncLocalStorage`) crossing           | 2 (+3 in C2b) | **Structural** — see §5.2                            |
| **C1** `Effect.promise` with a verified totality claim          | 4             | Correct; reasons now stated                          |
| **C2a** `Effect.promise`, totality deliberate, was undocumented | 5             | Documented in this pass                              |
| **C2b** `Effect.promise`, totality still unverified             | 5 → 4         | **Open** — see §5.1                                  |
| **Converted in this pass**                                      | 2             | §9                                                   |

`sig` in the tables below records whether the callback declares the
`AbortSignal`/interrupt parameter, i.e. whether the wrap is interruptible.

### A1 — Foreign runtime or library edge (28)

Permanent. Nothing to do.

| Site                                                            | Combinator          | Callee                       | Interruptible |
| --------------------------------------------------------------- | ------------------- | ---------------------------- | ------------- |
| `src/latex/arxivProcessor.ts:241`                               | `Effect.tryPromise` | fetch                        | yes           |
| `src/latex/arxivProcessor.ts:323`                               | `Effect.tryPromise` | node:stream pipeline         | —             |
| `src/latex/arxivProcessor.ts:355`                               | `Effect.tryPromise` | tar.x                        | —             |
| `src/telemetry/UsageLogService.ts:460`                          | `Effect.tryPromise` | ky.post                      | yes           |
| `src/platform/defaults/jsonStore.ts:64`                         | `Effect.tryPromise` | node:fs readFile             | —             |
| `src/platform/defaults/jsonStore.ts:92`                         | `Effect.tryPromise` | node:fs mkdir                | —             |
| `src/platform/defaults/jsonStore.ts:97`                         | `Effect.tryPromise` | node:fs chmod                | —             |
| `src/platform/defaults/jsonStore.ts:137`                        | `Effect.tryPromise` | write-file-atomic            | —             |
| `src/platform/defaults/nodeStores.ts:51`                        | `Effect.tryPromise` | node:fs access               | —             |
| `src/platform/defaults/fileLocks.ts:46`                         | `Effect.tryPromise` | node:fs mkdir                | —             |
| `src/platform/defaults/fileLocks.ts:51`                         | `Effect.tryPromise` | proper-lockfile lock         | —             |
| `src/platform/defaults/fileLocks.ts:66`                         | `Effect.tryPromise` | proper-lockfile release      | —             |
| `src/tools/zotero/bbtClient.ts:208`                             | `Effect.tryPromise` | ky.post                      | yes           |
| `src/tools/zotero/bbtClient.ts:268`                             | `Effect.tryPromise` | ky.get                       | yes           |
| `src/tools/zotero/bbtClient.ts:341`                             | `Effect.tryPromise` | ky.post                      | —             |
| `src/tools/zotero/bbtClient.ts:362`                             | `Effect.tryPromise` | ky response.json             | —             |
| `src/tools/web/WebFetchTool.ts:56`                              | `Effect.tryPromise` | ky.get                       | —             |
| `src/tools/web/WebSearchTool.ts:78`                             | `Effect.tryPromise` | ky.get                       | yes           |
| `src/tools/lean/LoogleTool.ts:121`                              | `Effect.tryPromise` | ky.get                       | yes           |
| `src/tools/lean/direct/leanServer.ts:431`                       | `Effect.tryPromise` | node:fs readFile             | yes           |
| `src/tools/lean/direct/leanServerPool.ts:597`                   | `Effect.tryPromise` | node:fs access               | —             |
| `packages/cli/src/runtime/history.ts:327`                       | `Effect.tryPromise` | node:fs readFile             | —             |
| `packages/cli/src/runtime/history.ts:374`                       | `Effect.tryPromise` | node:fs stat                 | —             |
| `packages/cli/src/runtime/history.ts:391`                       | `Effect.tryPromise` | node:fs cp                   | —             |
| `packages/cli/src/runtime/clipboardText.ts:44`                  | `Effect.tryPromise` | node:child_process execFile  | —             |
| `packages/cli/src/runtime/clipboardText.ts:66`                  | `Effect.tryPromise` | clipboardy / process probing | —             |
| `packages/cli/src/runtime/clipboardText.ts:133`                 | `Effect.tryPromise` | clipboardy write             | —             |
| `packages/extension/src/frontend/lean/VscodeIntegration.ts:324` | `Effect.tryPromise` | vscode LSP sendRequest       | —             |

### A2 — Host-port edge (13)

Correct while the port itself is Promise-typed. These convert only if
and when the port's own contract becomes Effect-typed; none is debt today.

| Site                                                           | Combinator          | Callee                                        | Interruptible |
| -------------------------------------------------------------- | ------------------- | --------------------------------------------- | ------------- |
| `src/controllers/settingsView/SettingsViewHost.ts:119`         | `Effect.tryPromise` | options.onError (host callback)               | —             |
| `src/controllers/settingsView/SettingsViewHost.ts:168`         | `Effect.tryPromise` | this.post — webview postMessage               | —             |
| `src/controllers/settingsView/SettingsViewHost.ts:178`         | `Effect.tryPromise` | this.postMaybe — webview postMessage          | —             |
| `src/controllers/settingsView/SettingsMemoryController.ts:74`  | `Effect.tryPromise` | PromptHost.confirm                            | —             |
| `src/controllers/settingsView/SettingsMemoryController.ts:103` | `Effect.tryPromise` | PromptHost.warning                            | —             |
| `src/auth/oauth/loopbackLogin.ts:217`                          | `Effect.tryPromise` | browser launch (host)                         | —             |
| `src/agent/index/platformAgentDirectories.ts:170`              | `Effect.tryPromise` | globalState.update (platform port)            | —             |
| `src/tools/agentCliSessionRegistry.ts:50`                      | `Effect.tryPromise` | dependencies.persistSessionId (injected port) | —             |
| `packages/desktop/src/main/index.ts:1184`                      | `Effect.tryPromise` | Electron setup entry                          | —             |
| `packages/desktop/src/main/index.ts:1229`                      | `Effect.tryPromise` | interactions.emit (Promise.resolve)           | —             |
| `packages/desktop/src/main/index.ts:1241`                      | `Effect.tryPromise` | interactions.emit (Promise.resolve)           | —             |
| `packages/desktop/src/main/index.ts:1607`                      | `Effect.tryPromise` | papers.open (Electron)                        | —             |
| `packages/cli/src/runtime/approval/approvalPrompts.ts:133`     | `Effect.tryPromise` | approvalPrompt / askCliQuestion (host UI)     | —             |

### B1 — Named generic wrappers (13, now 9)

One named helper per subsystem, applying one catch policy, reused by every
call site in that subsystem. These are the right shape — but each exists
_because_ a Promise-typed surface sits below it, so a wrapper's disappearance
is the signal that a subsystem finished converting.

**Nine of the thirteen are distinct; four were duplicates.** Each of the nine
maps its rejection to a domain error the subsystem owns — `executionsRead` to
`ExecutionsReadFailed`, `agentCliCall` to `AgentCliCallFailed`, `callPort` to
`AuthPortError`, and so on — so they are policy, not indirection. But five
carried the _identity_ catch and were textually the same helper under five
names: `hostPort` (`src/controllers/effectPort.ts`), `port`
(`githubSubscriptionTool.ts`), `tryPromise` (`initPlatform.ts`), `tryHost`
(`VscodeIntegration.ts`), and `step` (`modelAccessSelection.ts`). Collapsed to
one in this pass (§9).

Two facts made that collapse safe and were checked rather than assumed.
`Effect.tryPromise` catches a synchronous throw from `try` itself — its
implementation wraps the `f(signal)` call in its own `try`/`catch`
(`effect/dist/internal/effect.js:756`) — so the variants that passed `try`
directly and the ones that wrapped it in `async` differ only in whether the
callback may return a plain `A`. `hostPort`'s `() => A | PromiseLike<A>`
signature is the more general of the two and subsumes all five.

Inlining the nine that remain would be the wrong move in the other direction:
`executionsRead` has 36 call sites, `hostPort` 18 (before this pass), and
`agentCliCall` 10, so inlining would copy each catch policy into every one of
them.

| Site                                                            | Combinator          | Wrapper over                         | Interruptible |
| --------------------------------------------------------------- | ------------------- | ------------------------------------ | ------------- |
| `src/controllers/effectPort.ts:19`                              | `Effect.tryPromise` | hostPort — generic host-port wrapper | —             |
| `src/controllers/onboarding/OnboardingRefreshQueue.ts:21`       | `Effect.tryPromise` | this.refresh() — subsystem wrapper   | —             |
| `src/latex/arxivProcessor.ts:86`                                | `Effect.tryPromise` | arxiv run() wrapper                  | —             |
| `src/auth/oauth/deviceAuthorization.ts:115`                     | `Effect.tryPromise` | complete() wrapper                   | —             |
| `src/auth/authProgram.ts:26`                                    | `Effect.tryPromise` | authPort call() wrapper              | —             |
| `src/tools/ExecutionsTool.ts:132`                               | `Effect.tryPromise` | read() wrapper                       | —             |
| `src/tools/agentCliShared.ts:88`                                | `Effect.tryPromise` | agent CLI call() wrapper             | —             |
| `src/tools/support/rateLimiter.ts:75`                           | `Effect.tryPromise` | request() wrapper                    | —             |
| `src/tools/github/PollingSourceBase.ts:113`                     | `Effect.tryPromise` | request() wrapper                    | —             |
| `src/tools/github/githubSubscriptionTool.ts:174`                | `Effect.tryPromise` | generic promise wrapper              | —             |
| `packages/cli/src/runtime/initPlatform.ts:96`                   | `Effect.tryPromise` | run() wrapper                        | —             |
| `packages/cli/src/runtime/modelAccessSelection.ts:93`           | `Effect.tryPromise` | run() wrapper                        | —             |
| `packages/extension/src/frontend/lean/VscodeIntegration.ts:202` | `Effect.tryPromise` | run() wrapper                        | —             |

### B2 — Repo-owned promise APIs, re-wrapped at call sites (26)

**The conversion targets.** Every callee here is defined in this
repository and could carry an Effect signature; nothing foreign is being
crossed at the wrap. The wrap is a boundary sitting in the middle of a
program.

| Site                                                          | Combinator          | Callee (repo-owned)                            | Interruptible |
| ------------------------------------------------------------- | ------------------- | ---------------------------------------------- | ------------- |
| `src/controllers/settingsView/SettingsMemoryController.ts:85` | `Effect.tryPromise` | StorageFS.delete                               | —             |
| `src/latex/arxivProcessor.ts:161`                             | `Effect.tryPromise` | AbsoluteFS.delete                              | —             |
| `src/telemetry/UsageLogService.ts:360`                        | `Effect.tryPromise` | SupabaseClient.getAccessToken                  | —             |
| `src/agent/index/platformAgentDirectories.ts:90`              | `Effect.tryPromise` | GlobalStorageFS.read                           | —             |
| `src/agent/index/platformAgentDirectories.ts:124`             | `Effect.tryPromise` | GlobalStorageFS.ensureDir/write                | —             |
| `src/agent/index/platformAgentDirectories.ts:181`             | `Effect.tryPromise` | GlobalStorageFS.ensureDir + platform().fs.copy | —             |
| `src/tools/zotero/ZoteroAddTool.ts:216`                       | `Effect.tryPromise` | CrossrefClient.work                            | —             |
| `src/tools/agentCliShared.ts:295`                             | `Effect.tryPromise` | registerExecution                              | —             |
| `src/tools/arxiv/ArxivDownloadTool.ts:85`                     | `Effect.tryPromise` | listExtractedEntries — async fn in same file   | —             |
| `src/tools/github/StreamSubscriptionRegistry.ts:133`          | `Effect.tryPromise` | submitFollowUp                                 | —             |
| `src/tools/memory/memoryFileSystem.ts:118`                    | `Effect.tryPromise` | StorageFS.exists                               | —             |
| `src/tools/memory/memoryFileSystem.ts:126`                    | `Effect.tryPromise` | StorageFS.stat                                 | —             |
| `src/tools/memory/memoryFileSystem.ts:245`                    | `Effect.tryPromise` | StorageFS.readDir                              | —             |
| `src/tools/memory/memoryFileSystem.ts:382`                    | `Effect.tryPromise` | StorageFS.read                                 | —             |
| `src/tools/memory/memoryFileSystem.ts:403`                    | `Effect.tryPromise` | StorageFS.writeAtomic                          | —             |
| `src/tools/memory/MemoryTool.ts:67`                           | `Effect.tryPromise` | StorageFS.stat                                 | —             |
| `src/tools/memory/MemoryTool.ts:76`                           | `Effect.tryPromise` | StorageFS.ensureDir                            | —             |
| `src/tools/memory/MemoryTool.ts:279`                          | `Effect.tryPromise` | StorageFS.read                                 | —             |
| `src/tools/memory/MemoryTool.ts:302`                          | `Effect.tryPromise` | StorageFS.writeAtomic                          | —             |
| `src/tools/memory/MemoryTool.ts:538`                          | `Effect.tryPromise` | StorageFS.delete                               | —             |
| `src/tools/memory/MemoryTool.ts:574`                          | `Effect.tryPromise` | StorageFS.rename                               | —             |
| `packages/desktop/src/main/desktopPapers.ts:332`              | `Effect.tryPromise` | writeRememberedPapers                          | —             |
| `packages/desktop/src/main/platform/index.ts:178`             | `Effect.tryPromise` | refreshModelListAndLog                         | —             |
| `packages/agent/src/effect/sessions.ts:289`                   | `Effect.tryPromise` | loadAgents                                     | —             |
| `packages/agent/src/effect/sessions.ts:390`                   | `Effect.tryPromise` | runValidatedAgent (signal wired)               | yes           |
| `packages/cli/src/runtime/history.ts:576`                     | `Effect.tryPromise` | isCliRunResumable                              | —             |

### B3 — Ambient-context crossings (2 here, 3 more inside C2b)

| Site                                             | Combinator          | Callee                                     | Interruptible |
| ------------------------------------------------ | ------------------- | ------------------------------------------ | ------------- |
| `packages/desktop/src/main/desktopPapers.ts:224` | `Effect.tryPromise` | runWithWorkspaceRoots(StreamLogStore.open) | —             |
| `packages/desktop/src/main/desktopPapers.ts:433` | `Effect.tryPromise` | runInSession(flushArtifacts)               | —             |

### C1 — `Effect.promise` with a verified totality claim (4)

| Site                                          | Combinator       | Callee                                          | Interruptible |
| --------------------------------------------- | ---------------- | ----------------------------------------------- | ------------- |
| `src/platform/defaults/jsonStore.ts:29`       | `Effect.promise` | dynamic import()                                | —             |
| `src/auth/oauth/loopbackLogin.ts:86`          | `Effect.promise` | resolve-only http.createServer executor         | —             |
| `src/tools/ExecutionsTool.ts:163`             | `Effect.promise` | waitForAnyChange(signal) — signal wired         | yes           |
| `src/tools/lean/direct/leanServerPool.ts:391` | `Effect.promise` | runLakeCommand — execa `reject: false`, settles | —             |

`loopbackLogin.ts:86` wraps a resolve-only executor. `ExecutionsTool.ts:163`
wires the signal, waits on an in-memory notifier, and its enclosing
`awaitStatusChange` docstring already states that a throw there surfaces at
once by design. `jsonStore.ts:29` is a dynamic `import()`, which rejects only
on a broken bundle. `leanServerPool.ts:391` was filed as doubtful and is not:
`runLakeCommand` runs `execa` with `reject: false`
(`src/tools/lean/direct/lakeCommands.ts:70`), so a non-zero exit — and a
missing `lake` — comes back as a result rather than a rejection.

The two that lacked a stated reason (`jsonStore.ts:29`, `leanServerPool.ts:391`)
have one as of this pass.

### C2a — totality deliberate, previously undocumented (5)

| Site                                             | Combinator       | Callee                                             | Interruptible |
| ------------------------------------------------ | ---------------- | -------------------------------------------------- | ------------- |
| `src/controllers/session/SessionRequests.ts:154` | `Effect.promise` | stores().deleteStream — defect answered `Internal` | —             |
| `src/controllers/session/SessionRequests.ts:180` | `Effect.promise` | submitFollowUp                                     | —             |
| `src/controllers/session/SessionRequests.ts:261` | `Effect.promise` | session.interactions.settleRetry                   | —             |
| `src/controllers/session/SessionRequests.ts:285` | `Effect.promise` | handleExternalInquiryAction                        | —             |
| `src/controllers/session/sessionLayer.ts:163`    | `Effect.promise` | proveOwnerLiveness                                 | —             |

Two different justifications sit here, and both were verified rather than
assumed:

- **`SessionRequests` (three sites, plus `:154` moved down from C2b).** These
  callees model failure in the return value — `submitFollowUp` returns
  `{ status: 'failed', reason }`, `settleRetry` returns `boolean` and catches
  its own `prepareRetry`. But the load-bearing reason is downstream, not in the
  callee: `SessionBridge.defect()` (`src/controllers/session/SessionBridge.ts:317`)
  catches a handler defect, logs the cause under the request id, and answers
  `Internal` so the sender's latch clears. A rejection here is therefore
  already loud and already answered; routing it into `RequestError` instead
  would word a collaborator's breakage as a refusal the user could act on,
  which it is not. Documented in the file header in this pass rather than
  converted.
- **`sessionLayer.ts:163`.** `proveOwnerLiveness` returns
  `'unprovable' | 'dead' | …` and does not signal by rejecting.

### C2b — totality still unverified (5, now 4)

| Site                                          | Combinator       | Callee                                                  | Interruptible |
| --------------------------------------------- | ---------------- | ------------------------------------------------------- | ------------- |
| `src/controllers/session/sessionLayer.ts:508` | `Effect.promise` | runInSession(untilSettled) — B3 too; same-file async fn | yes           |
| `src/controllers/session/sessionLayer.ts:542` | `Effect.promise` | runInSession(session.flushArtifacts) — B3 too           | —             |
| `src/controllers/session/sessionLayer.ts:593` | `Effect.promise` | caller-supplied processStart promise                    | —             |
| `packages/agent/src/effect/runtime.ts:155`    | `Effect.promise` | disposeProcessRuntime in ensuring                       | —             |

Four remain open — `SessionEvents.ts:329` was the fifth and is gone with the
SQLite event plane. Three are in `sessionLayer.ts` and one in
`packages/agent/src/effect/runtime.ts` — the session-close and process-runtime
lifecycle, which is `Effect.uninterruptible`, races a budget, and carries
finalizers. `sessionLayer.ts:542` is the sharpest: `SessionHandle.ts:415`
wraps `flushArtifacts()` in a `try`/`catch` and logs "final artifacts did not
all persist", proving it rejects, while `:542`'s own comment claims "a flush
that fails still fails this close" — true, but as a `Die`, so no
`Effect.catch` on the close can classify it. Converting any of these changes
the `E` channel of `close`, and with it every caller's type; it belongs to the
lane that owns `sessionLayer`, not to a drive-by. See §9.

## 4. Findings, ranked

**F1. A totality claim that reads as a contradiction and is not one.**
`src/controllers/session/SessionRequests.ts:154` asserts
`stores().deleteStream(...)` cannot reject, while
`src/agent/storage/SessionStores.ts:904` calls the same method inside a
`try`/`catch` and routes the rejection to `retained`. Tracing the request path
resolves it in the first site's favour: `SessionBridge.defect()` already
catches a handler defect, logs the cause under the request id, and answers
`Internal`, so a rejection is neither lost nor silent, and the sender's latch
clears. The `Effect.promise` is deliberate. What was missing is that nothing
said so at the wrap — the file header now does.

**F2. One tool wrapped the same collaborator two different ways.**
`src/tools/ExecutionsTool.ts` declares `executionsRead` as "the one wrap of
this tool's Promise collaborators" and uses it at 30+ call sites. Two sites —
`:418` and `:602`, both running durable metadata reads under
`Effect.forEach` — used `Effect.promise` instead, keeping the same failure out
of the type channel the rest of the file routes it through. The end behavior
was already equivalent, because `execute` catches `ExecutionsReadFailed` and
re-raises it with `Effect.die(error.cause)`; the original audit overstated
this as a behavioral defect, and it is a consistency and type-honesty one.
Both are converted in this pass (§9).

**F3. The filesystem wrapper family is the largest cluster: 16 sites.**
Twelve wrap `StorageFS`, three `GlobalStorageFS`, one `AbsoluteFS` — all
descending from `BaseFS`/`RelativeFS` in `src/utils/files/`, all repo-owned,
all re-writing an equivalent catch mapper by hand at the call site
(`MemoryEntryUnreadable` / `MemoryFileUnwritable` appear eleven times between
`MemoryTool.ts` and `memoryFileSystem.ts`). Node's `fs` underneath is
genuinely foreign, so _something_ wraps it — the defect is that the wrap
happens sixteen times at the leaves instead of once at the base.

**F4. Twelve of 98 sites are interruption-wired.**
Ten declare the `AbortSignal` parameter; two more take the scope's signal with
`Effect.abortSignal` (`bbtClient.ts:340`, `WebFetchTool.ts:55`) — the idiom
`src/tools/timeouts.ts` documents, and the better one where a signal must
outlive a single request. The remaining 86 pass a zero-argument callback, so
`Effect.tryPromise` creates no signal and interruption returns while the
wrapped promise keeps running. Many of those bodies are short enough not to
matter; the ones that are not — HTTP posts, process spawns, recursive
directory copies — matter a great deal. This is the `new AbortController(`
debt of the effect-migration ratchet viewed from the entry side.

Wiring a signal into a site that lacks one is a behavior change (the operation
becomes cancellable mid-flight), so it belongs in the PR that converts that
site's subsystem, not in a sweep — see §7.

**F5. Two wraps cross no boundary at all.**
`sessionLayer.ts:508` wraps `untilSettled`, an `async function` declared at
line 437 of the same file. `ArxivDownloadTool.ts:85` wraps
`listExtractedEntries`, declared at line 30 of the same file. Nothing foreign
is being entered; the promise exists only because the helper was written
`async`.

**F6. A stated intent the channel does not deliver.**
`sessionLayer.ts:542` carries the comment "a flush that fails still fails this
close". Under `Effect.promise`, a `flushArtifacts()` rejection becomes a
**defect**: the close does fail, but its exit is `Die`, not `Fail`, so no
`Effect.catch` on the close can observe or classify it. Same shape at
`packages/agent/src/effect/runtime.ts:155`, where the defect would be raised
from inside an `Effect.ensuring` finalizer during release, and at
`sessionLayer.ts:593`, where a _host-supplied_ promise's rejection defects
layer construction.

## 5. Two structural items

### 5.1 `Effect.promise` is a stronger claim than it looks

`Effect.tryPromise` moves a rejection into the typed error channel;
`Effect.promise` asserts the promise **cannot reject** and turns a rejection
into a defect that bypasses the error channel entirely. Sixteen production
sites make that claim. Three are sound (C1), four are plausible but unstated
(C2a), and nine are doubtful (C2b) — F1, F2 and F6 are all instances.

This is the same failure mode CLAUDE.md names for `Zod .catch(default)` on
persisted data, inverted: not a failure quietly becoming a default, but a
failure quietly leaving the channel that was built to describe it. The
default should be `Effect.tryPromise`; `Effect.promise` should appear only
with a stated reason, as `loopbackLogin.ts:86` does.

### 5.2 The `AsyncLocalStorage` layer, and why it is last rather than first

`runInSession` (`src/agent/runtime/RunContext.ts:170`, over the
`AsyncLocalStorage` at line 79) and `runWithWorkspaceRoots`
(`src/platform/workspaceRoots.ts:98`, over the store at line 41) both take
`() => T | Promise<T>` and run it inside an ambient scope. Four sites wrap a
promise for no reason other than to cross one of those scopes —
`sessionLayer.ts:508`, `:542`, `desktopPapers.ts:224`, and `:433`. A fifth,
`SessionEvents.ts:329`, went with the SQLite event plane (#11978).
Ambient context propagated through the async call stack is what
Effect's `Context`/`FiberRef` provides natively, and `sessionLayer` already
carries `Sessions` and `ProcessIdentity` as layers, so the replacement looks
obvious.

It was scoped directly, and it is not available as its own step. Four
findings, in the order that settles it:

**The entries are not the work; the readers are.** Scope _entry_ is a small,
tractable surface — 2 `runWithWorkspaceRoots` call sites (one of them internal
to `withRunContext`) and 25 `runInSession` sites. Scope _reading_ is not:
`workspaceRoots()` has 44 call sites, `tryUseRunContext()` 55, and
`currentSession()` 52 (which resolves through `tryUseRunContext`). A
`FiberRef` or a `Context` service is readable only from inside an Effect, so
every one of those readers must already be an Effect program before the
mechanism underneath them can change. Converting the 28 entries while ~150
readers still read ambiently would not remove the layer; it would break it.

**The hardest readers cannot be converted in place.**
`StorageFS.getBasePath()` and `WorkspaceFS.getBasePath()` are _synchronous
static_ overrides, called from `RelativeFS.resolvePath()` through
`BaseFS.preparePath()` — synchronous the whole way, inside Promise-returning
statics. A `FiberRef` cannot serve a synchronous static. Those readers stop
being synchronous only when the filesystem stack itself becomes Effect-typed,
which is W1. **The ordering is therefore forced: W1 before W6.** W6 is the
last layer to go, not the first — it is currently the only mechanism by which
Promise-typed core code is session-scoped at all.

**The two scopes cannot be collapsed into one either.** `withRunContext`
enters `runContextScope` and, when the context carries a session, also enters
`rootsScope` with `session.roots`, so the second scope's contents are
derivable from the first wherever a run is active. Having `workspaceRoots()`
read the run context instead would invert the layering: `workspaceRoots` lives
in `src/platform/` and `RunContext` in `src/agent/runtime/`, and platform
importing agent is an edge the `architecture-edges` ratchet and
`dependencyDirection.vitest.ts` both hold shut. The redundancy is real and it
is load-bearing in the correct direction.

**The 25 `runInSession` entries do not collapse to fewer.** Sixteen are in
`packages/desktop/src/main/`, and they are not one dispatch point: each scopes
a _different_ paper's session across heterogeneous operations — binding
disposal (`index.ts:829`, `:841`, `:1385`), catalog refresh over every binding
at once (`:858`), a validated run launch (`:1205`), workspace message handling
(`:1376`). A host holding one session per open paper has to name the session
at each of them. Three of the disposal calls are textually identical, which is
a three-caller helper at best and below this repository's extraction bar.

So W6 stays raised and unscheduled, but no longer for want of analysis: it is
blocked on W1, and the reach beyond this audit is confirmed (`TraceEmitter`
and `AgentTrace` hold a third `AsyncLocalStorage` for stage scope).

## 6. What this note deliberately does not propose

- **No new lint rule and no `tryPromise` ratchet row.** CLAUDE.md records that
  the open work is the Tier-1 public manifest and shrinking the frozen lists,
  "not another lint rule". A shrink-only count of `Effect.tryPromise` would
  also be actively wrong: entry sites _should_ rise as the Effect surface
  grows outward, so such a row would penalize correct work. The existing
  `Effect.run*` row already fences the direction that is debt.
- **No adapters.** Per the owner ruling of 2026-09-06, a converted callee's
  consumers convert upward to a real boundary in the same PR; no
  `@adapter-until` marker, no pass-through shim.
- **No test suite.** The B2 conversions are behavior-preserving and add none,
  per AGENTS.md testing discipline; the two that landed here (§9) are in that
  class and add none. A future C2b fix does change behavior (defect → typed
  failure) and earns at most one regression test each, and only where the
  wrong channel is observable — `sessionLayer.ts:542` would qualify, the rest
  likely do not.

## 7. Proposed work, by leverage

| #   | Work                                                             | Sites        | Status                                   |
| --- | ---------------------------------------------------------------- | ------------ | ---------------------------------------- |
| W1  | Effect-typed surface on the `src/utils/files/` FS base classes   | 16 (F3)      | **Blocked**: lane-sized — see below      |
| W2  | Unverified `Effect.promise` totality claims                      | 5 (C2b)      | Open; belongs to the `sessionLayer` lane |
| W3  | State the reason where totality is deliberate                    | 9 (C1 + C2a) | **Done** (§9)                            |
| W4  | Use the tool's own wrapper where the file already has one        | 2 (F2)       | **Done** (§9)                            |
| W5  | Remaining B2 singletons, each with the lane owning its subsystem | 10           | Open; folded into existing lanes         |
| W6  | The `AsyncLocalStorage` layer                                    | 5 (§5.2)     | **Blocked on W1** — scoped, see §5.2     |
| W7  | `effect/unstable/*` adoption for the foreign edges               | 28 (A1)      | Needs an owner ruling first (§2.5)       |
| W8  | Collapse the duplicate identity-catch wrappers                   | 4 (B1)       | **Done** (§9)                            |

### W1's real shape

The first draft called `BaseFS` "21 static async methods". It declares **29
members**, and the difference matters, because a third of them never convert:

- **17 async methods** convert. Five dominate the work — `read` (63 call
  sites), `exists` (60), `ensureDir` (40), `delete` (32), `write` (20) — and
  the tail is thin: `publish`, `removeEmptyDir` and `isSymbolicLink` have one
  production caller each.
- **8 synchronous or stream members do not**: `existsSync`, `readSync`,
  `readBytesSync`, `deleteSync`, `statSync`, `createReadStream`,
  `createWriteStream`, `fullPath`. A synchronous API has no Effect to return
  that would help its callers, and the stream factories hand back Node
  streams. (A ninth, `mkdirSync`, had no caller at all and is deleted — §9.)
- `RelativeFS` adds `readJson` and `cleanupOldFiles`; `WorkspaceFS` adds four
  synchronous path helpers (`getPath`, `relativePath`, `toAbsolute`,
  `locatePath`) with 81 production uses between them, none of which convert.

So W1 leaves a mixed class behind: an Effect-typed async surface beside a
synchronous one that stays as it is. That is not a defect of the plan — a
`statSync` is not a boundary — but it should be expected rather than
discovered.

**There is no smaller legal slice.** Converting one method looks like the
obvious increment, and it is not one: `removeEmptyDir`'s single consumer is
`src/agent/storage/executionLease.ts`, `publish`'s and `isSymbolicLink`'s
consumers are likewise ordinary `async` functions, and none of those files
contains an Effect program today. Under the 2026-09-06 ruling the consumer
converts upward to a real boundary in the same PR, so the cascade starts at
the first method, whichever one is chosen. Per-method is not a smaller unit
than per-class.

The cascade's size was measured rather than estimated: of the ~29 files that
call these classes, **only four contain any `Effect.fn`/`Effect.gen` at all**
(`arxivProcessor.ts`, `memoryFileSystem.ts`, `MemoryTool.ts`,
`platformAgentDirectories.ts`). The other 25 — `StagedDeletionCoordinator`
(14 calls), `runStorageFs` (12), `AcceptRunFilesTool` (11), `img.ts` (10),
`executionLease` (9), `KVStore` (8), `XmlOutputManager` (8) among them — are
wholly Promise-based, so W1 does not merely retype 113 call sites: it turns
25 non-Effect files into Effect programs and then converts their callers
upward.

W1 is therefore atomic. It lands as one PR, or it needs a ruling that permits
a temporary adapter — which the 2026-09-06 ruling forbids.

**Two items the first draft called trivial are not.** Both would only move a
wrap inward rather than remove it, which is the pass-through the design
guardrails forbid:

- `ArxivDownloadTool.ts:85` wraps `listExtractedEntries`, an `async function`
  in the same file — but that function awaits `WorkspaceFS.readDir` and
  `getGitignoreMatcher()`. Making it an `Effect.fn` relocates the
  `tryPromise` one level down. It is a W1 dependent.
- `sessionLayer.ts:508` wraps `untilSettled`, likewise same-file — but the
  call site is `runInSession(session, () => untilSettled(...))`, an
  `AsyncLocalStorage` scope. An ambient scope cannot wrap an Effect across
  suspension points, so this one is a W6 dependent.

## 8. Reproducing this audit

The classification map lives in this note's tables, keyed by `file:line`; the
site list regenerates with the `grep` in §1, minus test files and comment
mentions. Line numbers are as of the commit that adds this note and will
drift.

## 9. What landed with this note

Verified against a clean `npm run typecheck` before and after, and
`node scripts/check-effect-migration-ratchet.mjs` (no count grew).

**Converted (W4) — behavior-preserving:**

| Site                              | Combinator       | Change                        | Interruptible |
| --------------------------------- | ---------------- | ----------------------------- | ------------- |
| `src/tools/ExecutionsTool.ts:418` | `Effect.promise` | converted to `executionsRead` | —             |
| `src/tools/ExecutionsTool.ts:602` | `Effect.promise` | converted to `executionsRead` | —             |

Both now use `executionsRead`, the wrapper the file declares as "the one wrap
of this tool's Promise collaborators" and already uses at 30+ sites. The
failure was reaching `execute`'s `Effect.die(error.cause)` either way; it now
does so through the typed channel rather than around it.

**Collapsed (W8) — four duplicate wrappers and five inline copies:**

The identity-catch host-port wrapper existed five times under five names.
`src/controllers/effectPort.ts` moved to `src/common/hostPort.ts` and the
other four were deleted in favour of it:

| Deleted                            | Was called | Now        |
| ---------------------------------- | ---------- | ---------- |
| `githubSubscriptionTool.ts` `port` | 6 sites    | `hostPort` |
| `VscodeIntegration.ts` `tryHost`   | 7 sites    | `hostPort` |
| `initPlatform.ts` `tryPromise`     | 4 sites    | `hostPort` |
| `modelAccessSelection.ts` `step`   | 5 sites    | `hostPort` |

Then the same shape inline, five more sites that had never been given a name
— each an identity catch over a host call, followed by its own
`.pipe(Effect.catch(...))`:

| Site                            | Was                            |
| ------------------------------- | ------------------------------ |
| `OnboardingRefreshQueue.ts:21`  | host `refresh()` callback      |
| `desktop/index.ts:1607`         | `papers.open(root)`            |
| `desktop/platform/index.ts:178` | `refreshModelListAndLog`       |
| `desktopPapers.ts:332`          | `writeRememberedPapers`        |
| `desktopPapers.ts:433`          | `runInSession(flushArtifacts)` |

The last of those also loses an `async`/`await` wrapper: `hostPort` accepts
`() => A | PromiseLike<A>`, and `runInSession` already returns
`T | Promise<T>`, so the callback no longer has to normalise it.

Not swept: the identity catches over `ky`, `node:fs`, `execFile` and
`clipboardy`. Those are foreign _library_ edges rather than host ports, several
declare a signal or type their catch as `NodeJS.ErrnoException`, and
`hostPort`'s contract ("a host port has no cancellation to hand it") would be
a poor fit. They stay as they are.

`common` rather than `controllers` because the subsystem-edge baseline records
**no inbound edge to `controllers` at all** — `src/tools` importing it would
have created a new directed pair and failed the ratchet — while
`tools → common`, `controllers → common`, and the hosts' own `@common` imports
all already exist. The helper depends on nothing but `effect`, so `controllers`
was never its right home.

**Documented (W3) — no behavior change:**

- `src/controllers/session/SessionRequests.ts` — file header now records that a
  collaborator's rejection here is a handler defect answered `Internal` by
  `SessionBridge`, and why that is not a `RequestError`.
- `src/tools/lean/direct/leanServerPool.ts:391` — records that `runLakeCommand`
  runs `execa` with `reject: false` and settles rather than rejecting.
- `src/platform/defaults/jsonStore.ts:29` — records why the deferred `import()`
  is total.

`loopbackLogin.ts:86` and `ExecutionsTool.ts:163` already carried their
reasons and were left alone.

**Deleted:** `BaseFS.mkdirSync` — no caller in production or tests; every
other `mkdirSync` in the tree is Node's own. One member fewer for W1 to carry.

**Deliberately not done:** W1, W2, W5, W6, W7 — each for the reason given in
§7. The common thread is that the remaining wraps are not local mistakes; they
are the visible edge of three decisions that have owners (the FS surface, the
ambient-context mechanism, and `effect/unstable/*` adoption). Converting any
of them at the call site alone would produce the adapter the migration ruling
forbids.
