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
   `AbortSignal` only when the callback *declares the parameter*. Ten of the
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

**Direction matters more than count.** `Effect.tryPromise` is *entry*
(Promise → Effect) and is unbounded — a growing Effect surface produces more
of them at the rim. `Effect.runPromise` is *exit* (Effect → Promise) and is
the real debt marker, because it means the caller above is still
Promise-typed. `scripts/check-effect-migration-ratchet.mjs` counts only
`Effect.run*`, and only below R1's three boundary kinds. **That asymmetry is
correct, and this audit does not propose changing it** — see §6.

## 3. Taxonomy and counts

| Category | Sites | Verdict |
| --- | --- | --- |
| **A1** Foreign runtime or library edge | 28 | Permanent and correct |
| **A2** Host-port edge (Promise-typed port) | 13 | Correct while the port is Promise-typed |
| **B1** Named generic wrapper (one per subsystem) | 13 | Correct shape; each marks a Promise surface below it |
| **B2** Repo-owned promise API, re-wrapped at call sites | 26 | **Debt** — the conversion targets |
| **B3** Ambient-context (`AsyncLocalStorage`) crossing | 2 (+3 in C2b) | **Structural** — see §5.2 |
| **C1** `Effect.promise` with a sound totality claim | 3 | Correct; two want a one-line comment |
| **C2a** `Effect.promise`, totality plausible but undocumented | 4 | Document or convert |
| **C2b** `Effect.promise`, totality doubtful | 9 | **Fix** — see §5.1 |

`sig` in the tables below records whether the callback declares the
`AbortSignal`/interrupt parameter, i.e. whether the wrap is interruptible.

### A1 — Foreign runtime or library edge (28)

Permanent. Nothing to do.

| Site | Combinator | Callee | Interruptible |
| --- | --- | --- | --- |
| `src/latex/arxivProcessor.ts:241` | `Effect.tryPromise` | fetch | yes |
| `src/latex/arxivProcessor.ts:323` | `Effect.tryPromise` | node:stream pipeline | — |
| `src/latex/arxivProcessor.ts:355` | `Effect.tryPromise` | tar.x | — |
| `src/telemetry/UsageLogService.ts:460` | `Effect.tryPromise` | ky.post | yes |
| `src/platform/defaults/jsonStore.ts:64` | `Effect.tryPromise` | node:fs readFile | — |
| `src/platform/defaults/jsonStore.ts:92` | `Effect.tryPromise` | node:fs mkdir | — |
| `src/platform/defaults/jsonStore.ts:97` | `Effect.tryPromise` | node:fs chmod | — |
| `src/platform/defaults/jsonStore.ts:137` | `Effect.tryPromise` | write-file-atomic | — |
| `src/platform/defaults/nodeStores.ts:51` | `Effect.tryPromise` | node:fs access | — |
| `src/platform/defaults/fileLocks.ts:46` | `Effect.tryPromise` | node:fs mkdir | — |
| `src/platform/defaults/fileLocks.ts:51` | `Effect.tryPromise` | proper-lockfile lock | — |
| `src/platform/defaults/fileLocks.ts:66` | `Effect.tryPromise` | proper-lockfile release | — |
| `src/tools/zotero/bbtClient.ts:208` | `Effect.tryPromise` | ky.post | yes |
| `src/tools/zotero/bbtClient.ts:268` | `Effect.tryPromise` | ky.get | yes |
| `src/tools/zotero/bbtClient.ts:341` | `Effect.tryPromise` | ky.post | — |
| `src/tools/zotero/bbtClient.ts:362` | `Effect.tryPromise` | ky response.json | — |
| `src/tools/web/WebFetchTool.ts:56` | `Effect.tryPromise` | ky.get | — |
| `src/tools/web/WebSearchTool.ts:78` | `Effect.tryPromise` | ky.get | yes |
| `src/tools/lean/LoogleTool.ts:121` | `Effect.tryPromise` | ky.get | yes |
| `src/tools/lean/direct/leanServer.ts:431` | `Effect.tryPromise` | node:fs readFile | yes |
| `src/tools/lean/direct/leanServerPool.ts:597` | `Effect.tryPromise` | node:fs access | — |
| `packages/cli/src/runtime/history.ts:327` | `Effect.tryPromise` | node:fs readFile | — |
| `packages/cli/src/runtime/history.ts:374` | `Effect.tryPromise` | node:fs stat | — |
| `packages/cli/src/runtime/history.ts:391` | `Effect.tryPromise` | node:fs cp | — |
| `packages/cli/src/runtime/clipboardText.ts:44` | `Effect.tryPromise` | node:child_process execFile | — |
| `packages/cli/src/runtime/clipboardText.ts:66` | `Effect.tryPromise` | clipboardy / process probing | — |
| `packages/cli/src/runtime/clipboardText.ts:133` | `Effect.tryPromise` | clipboardy write | — |
| `packages/extension/src/frontend/lean/VscodeIntegration.ts:324` | `Effect.tryPromise` | vscode LSP sendRequest | — |

### A2 — Host-port edge (13)

Correct while the port itself is Promise-typed. These convert only if
and when the port's own contract becomes Effect-typed; none is debt today.

| Site | Combinator | Callee | Interruptible |
| --- | --- | --- | --- |
| `src/controllers/settingsView/SettingsViewHost.ts:119` | `Effect.tryPromise` | options.onError (host callback) | — |
| `src/controllers/settingsView/SettingsViewHost.ts:168` | `Effect.tryPromise` | this.post — webview postMessage | — |
| `src/controllers/settingsView/SettingsViewHost.ts:178` | `Effect.tryPromise` | this.postMaybe — webview postMessage | — |
| `src/controllers/settingsView/SettingsMemoryController.ts:74` | `Effect.tryPromise` | PromptHost.confirm | — |
| `src/controllers/settingsView/SettingsMemoryController.ts:103` | `Effect.tryPromise` | PromptHost.warning | — |
| `src/auth/oauth/loopbackLogin.ts:217` | `Effect.tryPromise` | browser launch (host) | — |
| `src/agent/index/platformAgentDirectories.ts:170` | `Effect.tryPromise` | globalState.update (platform port) | — |
| `src/tools/agentCliSessionRegistry.ts:50` | `Effect.tryPromise` | dependencies.persistSessionId (injected port) | — |
| `packages/desktop/src/main/index.ts:1184` | `Effect.tryPromise` | Electron setup entry | — |
| `packages/desktop/src/main/index.ts:1229` | `Effect.tryPromise` | interactions.emit (Promise.resolve) | — |
| `packages/desktop/src/main/index.ts:1241` | `Effect.tryPromise` | interactions.emit (Promise.resolve) | — |
| `packages/desktop/src/main/index.ts:1607` | `Effect.tryPromise` | papers.open (Electron) | — |
| `packages/cli/src/runtime/approval/approvalPrompts.ts:133` | `Effect.tryPromise` | approvalPrompt / askCliQuestion (host UI) | — |

### B1 — Named generic wrappers (13)

The `hostPort` shape: one named helper per subsystem, applying one catch
policy, reused by every call site in that subsystem.
`src/controllers/effectPort.ts:19` is the reference version, and its
doc comment already states why the catch is identity and why no signal is
passed. These are the right shape — but each one exists *because* a
Promise-typed surface sits below it, so a wrapper's disappearance is the
signal that a subsystem finished converting.

| Site | Combinator | Wrapper over | Interruptible |
| --- | --- | --- | --- |
| `src/controllers/effectPort.ts:19` | `Effect.tryPromise` | hostPort — generic host-port wrapper | — |
| `src/controllers/onboarding/OnboardingRefreshQueue.ts:21` | `Effect.tryPromise` | this.refresh() — subsystem wrapper | — |
| `src/latex/arxivProcessor.ts:86` | `Effect.tryPromise` | arxiv run() wrapper | — |
| `src/auth/oauth/deviceAuthorization.ts:115` | `Effect.tryPromise` | complete() wrapper | — |
| `src/auth/authProgram.ts:26` | `Effect.tryPromise` | authPort call() wrapper | — |
| `src/tools/ExecutionsTool.ts:132` | `Effect.tryPromise` | read() wrapper | — |
| `src/tools/agentCliShared.ts:88` | `Effect.tryPromise` | agent CLI call() wrapper | — |
| `src/tools/support/rateLimiter.ts:75` | `Effect.tryPromise` | request() wrapper | — |
| `src/tools/github/PollingSourceBase.ts:113` | `Effect.tryPromise` | request() wrapper | — |
| `src/tools/github/githubSubscriptionTool.ts:174` | `Effect.tryPromise` | generic promise wrapper | — |
| `packages/cli/src/runtime/initPlatform.ts:96` | `Effect.tryPromise` | run() wrapper | — |
| `packages/cli/src/runtime/modelAccessSelection.ts:93` | `Effect.tryPromise` | run() wrapper | — |
| `packages/extension/src/frontend/lean/VscodeIntegration.ts:202` | `Effect.tryPromise` | run() wrapper | — |

### B2 — Repo-owned promise APIs, re-wrapped at call sites (26)

**The conversion targets.** Every callee here is defined in this
repository and could carry an Effect signature; nothing foreign is being
crossed at the wrap. The wrap is a boundary sitting in the middle of a
program.

| Site | Combinator | Callee (repo-owned) | Interruptible |
| --- | --- | --- | --- |
| `src/controllers/settingsView/SettingsMemoryController.ts:85` | `Effect.tryPromise` | StorageFS.delete | — |
| `src/latex/arxivProcessor.ts:161` | `Effect.tryPromise` | AbsoluteFS.delete | — |
| `src/telemetry/UsageLogService.ts:360` | `Effect.tryPromise` | SupabaseClient.getAccessToken | — |
| `src/agent/index/platformAgentDirectories.ts:90` | `Effect.tryPromise` | GlobalStorageFS.read | — |
| `src/agent/index/platformAgentDirectories.ts:124` | `Effect.tryPromise` | GlobalStorageFS.ensureDir/write | — |
| `src/agent/index/platformAgentDirectories.ts:181` | `Effect.tryPromise` | GlobalStorageFS.ensureDir + platform().fs.copy | — |
| `src/tools/zotero/ZoteroAddTool.ts:216` | `Effect.tryPromise` | CrossrefClient.work | — |
| `src/tools/agentCliShared.ts:295` | `Effect.tryPromise` | registerExecution | — |
| `src/tools/arxiv/ArxivDownloadTool.ts:85` | `Effect.tryPromise` | listExtractedEntries — async fn in same file | — |
| `src/tools/github/StreamSubscriptionRegistry.ts:133` | `Effect.tryPromise` | submitFollowUp | — |
| `src/tools/memory/memoryFileSystem.ts:118` | `Effect.tryPromise` | StorageFS.exists | — |
| `src/tools/memory/memoryFileSystem.ts:126` | `Effect.tryPromise` | StorageFS.stat | — |
| `src/tools/memory/memoryFileSystem.ts:245` | `Effect.tryPromise` | StorageFS.readDir | — |
| `src/tools/memory/memoryFileSystem.ts:382` | `Effect.tryPromise` | StorageFS.read | — |
| `src/tools/memory/memoryFileSystem.ts:403` | `Effect.tryPromise` | StorageFS.writeAtomic | — |
| `src/tools/memory/MemoryTool.ts:67` | `Effect.tryPromise` | StorageFS.stat | — |
| `src/tools/memory/MemoryTool.ts:76` | `Effect.tryPromise` | StorageFS.ensureDir | — |
| `src/tools/memory/MemoryTool.ts:279` | `Effect.tryPromise` | StorageFS.read | — |
| `src/tools/memory/MemoryTool.ts:302` | `Effect.tryPromise` | StorageFS.writeAtomic | — |
| `src/tools/memory/MemoryTool.ts:538` | `Effect.tryPromise` | StorageFS.delete | — |
| `src/tools/memory/MemoryTool.ts:574` | `Effect.tryPromise` | StorageFS.rename | — |
| `packages/desktop/src/main/desktopPapers.ts:332` | `Effect.tryPromise` | writeRememberedPapers | — |
| `packages/desktop/src/main/platform/index.ts:178` | `Effect.tryPromise` | refreshModelListAndLog | — |
| `packages/agent/src/effect/sessions.ts:289` | `Effect.tryPromise` | loadAgents | — |
| `packages/agent/src/effect/sessions.ts:390` | `Effect.tryPromise` | runValidatedAgent (signal wired) | yes |
| `packages/cli/src/runtime/history.ts:576` | `Effect.tryPromise` | isCliRunResumable | — |

### B3 — Ambient-context crossings (2 here, 3 more inside C2b)

| Site | Combinator | Callee | Interruptible |
| --- | --- | --- | --- |
| `packages/desktop/src/main/desktopPapers.ts:224` | `Effect.tryPromise` | runWithWorkspaceRoots(StreamLogStore.open) | — |
| `packages/desktop/src/main/desktopPapers.ts:433` | `Effect.tryPromise` | runInSession(flushArtifacts) | — |

### C1 — `Effect.promise` with a sound totality claim (3)

| Site | Combinator | Callee | Interruptible |
| --- | --- | --- | --- |
| `src/platform/defaults/jsonStore.ts:29` | `Effect.promise` | dynamic import() | — |
| `src/auth/oauth/loopbackLogin.ts:86` | `Effect.promise` | resolve-only http.createServer executor | — |
| `src/tools/ExecutionsTool.ts:163` | `Effect.promise` | waitForAnyChange(signal) — signal wired | yes |

`loopbackLogin.ts:86` wraps a resolve-only executor — genuinely total.
`ExecutionsTool.ts:163` wires the signal and waits on an in-memory
change notifier. `jsonStore.ts:29` is a dynamic `import()`, which
rejects only on a broken build. All three are fine; the latter two would
read better with the one-line justification `loopbackLogin` already has.

### C2a — totality plausible but undocumented (4)

| Site | Combinator | Callee | Interruptible |
| --- | --- | --- | --- |
| `src/controllers/session/SessionRequests.ts:180` | `Effect.promise` | submitFollowUp | — |
| `src/controllers/session/SessionRequests.ts:261` | `Effect.promise` | session.interactions.settleRetry | — |
| `src/controllers/session/SessionRequests.ts:285` | `Effect.promise` | handleExternalInquiryAction | — |
| `src/controllers/session/sessionLayer.ts:163` | `Effect.promise` | proveOwnerLiveness | — |

These callees model failure **in the return value** rather than by
rejecting — `submitFollowUp` returns `{ status: 'failed', reason }`,
`settleRetry` returns `boolean` and catches its own `prepareRetry`,
`proveOwnerLiveness` returns `'unprovable' | 'dead' | …`. So
`Effect.promise` is defensible as a deliberate claim. It is nowhere
*stated*, and none of the three is total by construction — each awaits
further internal work that can reject. Cheap fix: a one-line comment, or
`Effect.tryPromise` with a typed failure.

### C2b — totality doubtful (9)

| Site | Combinator | Callee | Interruptible |
| --- | --- | --- | --- |
| `src/controllers/session/SessionRequests.ts:154` | `Effect.promise` | stores().deleteStream | — |
| `src/controllers/session/sessionLayer.ts:508` | `Effect.promise` | runInSession(untilSettled) — B3 too; same-file async fn | yes |
| `src/controllers/session/sessionLayer.ts:542` | `Effect.promise` | runInSession(session.flushArtifacts) — B3 too | — |
| `src/controllers/session/sessionLayer.ts:593` | `Effect.promise` | caller-supplied processStart promise | — |
| `src/agent/runtime/SessionEvents.ts:329` | `Effect.promise` | runWithWorkspaceRoots(transcripts.readEntries) — B3 too | — |
| `src/tools/ExecutionsTool.ts:418` | `Effect.promise` | formatListingLine — durable reads inside | — |
| `src/tools/ExecutionsTool.ts:602` | `Effect.promise` | formatChildLine + readMeta | — |
| `src/tools/lean/direct/leanServerPool.ts:391` | `Effect.promise` | runLakeCommand — spawns a process | — |
| `packages/agent/src/effect/runtime.ts:155` | `Effect.promise` | disposeProcessRuntime in ensuring | — |

## 4. Findings, ranked

**F1. A totality claim the repo itself contradicts.**
`src/controllers/session/SessionRequests.ts:154` asserts
`stores().deleteStream(...)` cannot reject. `src/agent/storage/SessionStores.ts:904`
calls the same method inside a `try`/`catch` and routes the rejection to
`retained`. One caller guards it; the other declares it impossible. Whichever
is right, both cannot be.

**F2. A per-row read failure defects a whole tool call.**
`ExecutionsTool.ts:418` and `:602` run `formatListingLine` / `formatChildLine`
under `Effect.forEach` via `Effect.promise`. Both are `async` functions in
`src/tools/executionFormatters.ts`, a file containing **zero** `catch`, and
both await execution metadata reads from disk. One unreadable execution
therefore dies the entire `executions` listing rather than degrading one line.
The `Effect.forEach` around them exists precisely to process rows
independently.

**F3. The filesystem wrapper family is the largest cluster: 16 sites.**
Twelve wrap `StorageFS`, three `GlobalStorageFS`, one `AbsoluteFS` — all
descending from `BaseFS`/`RelativeFS` in `src/utils/files/`, all repo-owned,
all re-writing an equivalent catch mapper by hand at the call site
(`MemoryEntryUnreadable` / `MemoryFileUnwritable` appear eleven times between
`MemoryTool.ts` and `memoryFileSystem.ts`). Node's `fs` underneath is
genuinely foreign, so *something* wraps it — the defect is that the wrap
happens sixteen times at the leaves instead of once at the base.

**F4. Ten of 98 sites declare the `AbortSignal`.**
The other 88 pass a zero-argument callback, so `Effect.tryPromise` creates no
signal and interruption returns while the wrapped promise keeps running. Many
of those bodies are short enough not to matter; the ones that are not — HTTP
posts, process spawns, recursive directory copies — matter a great deal. This
is the `new AbortController(` debt of the effect-migration ratchet viewed from
the entry side.

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
`sessionLayer.ts:593`, where a *host-supplied* promise's rejection defects
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

### 5.2 Five wraps exist only to cross an `AsyncLocalStorage` scope

`runInSession` (`src/agent/runtime/RunContext.ts:170`, over the
`AsyncLocalStorage` at line 79) and `runWithWorkspaceRoots`
(`src/platform/workspaceRoots.ts:98`, over the store at line 41) both take
`() => T | Promise<T>` and run it inside an ambient scope. Five sites wrap a
promise for no reason other than to cross one of those scopes —
`sessionLayer.ts:508`, `:542`, `SessionEvents.ts:329`,
`desktopPapers.ts:224`, `:433`.

Ambient context propagated through the async call stack is exactly what
Effect's `Context`/`FiberRef` provides natively, and `sessionLayer` already
carries `Sessions` and `ProcessIdentity` as layers. These five do not
disappear by converting a callee — they disappear when the `AsyncLocalStorage`
does. That is an architectural decision with reach well beyond this audit
(`TraceEmitter` and `AgentTrace` use the same mechanism), so it is raised
here and not scheduled.

## 6. What this note deliberately does not propose

- **No new lint rule and no `tryPromise` ratchet row.** CLAUDE.md records that
  the open work is the Tier-1 public manifest and shrinking the frozen lists,
  "not another lint rule". A shrink-only count of `Effect.tryPromise` would
  also be actively wrong: entry sites *should* rise as the Effect surface
  grows outward, so such a row would penalize correct work. The existing
  `Effect.run*` row already fences the direction that is debt.
- **No adapters.** Per the owner ruling of 2026-09-06, a converted callee's
  consumers convert upward to a real boundary in the same PR; no
  `@adapter-until` marker, no pass-through shim.
- **No test suite.** The B2 conversions are behavior-preserving and add none,
  per AGENTS.md testing discipline. The C2b fixes do change behavior (defect
  → typed failure) and earn at most one regression test each, and only where
  the wrong channel is observable — F1 and F2 qualify, the rest likely do not.

## 7. Proposed work, by leverage

| # | Work | Sites retired | Size |
| --- | --- | --- | --- |
| W1 | Effect-typed surface on the `src/utils/files/` FS base classes | 16 (F3) | Lane-sized |
| W2 | C2b sites → `Effect.tryPromise` with a typed failure, or a stated reason | 9 (F1, F2, F6) | Small, independently mergeable |
| W3 | C2a sites → one-line justification comment | 4 | Trivial |
| W4 | Convert the two same-file `async` helpers, delete the wraps | 2 (F5) | Trivial |
| W5 | Remaining B2 singletons, each with the lane owning its subsystem | 9 | Folded into existing lanes |
| W6 | The `AsyncLocalStorage` question | 5 (§5.2) | Needs an owner ruling first |

The column does not sum to 98: W4's two sites are also counted under W2
(`sessionLayer.ts:508`) and W5 (`ArxivDownloadTool.ts:85`), W6 overlaps W2
at three sites, and the 54 A1/A2/B1 sites are retired by nothing — they are
the destination.

**W2 first.** It is the smallest change, it is the only group where the
current code can lose an error, and it needs no coordination with any lane.
W1 is the largest single reduction but touches a browser-safety-constrained
directory (`src/utils/` — see the browser-reachable module set in CLAUDE.md)
and should be scoped as its own lane.

F4 (interruptibility) is not a separate work item: a converted callee is
interruptible by construction, and for the A1 sites that stay foreign, the fix
is to declare the `signal` parameter where the library already accepts one —
worth doing opportunistically in whichever PR touches the site, not as a sweep.

## 8. Reproducing this audit

The classification map lives in this note's tables, keyed by `file:line`; the
site list regenerates with the `grep` in §1, minus test files and comment
mentions. Line numbers are as of the commit that adds this note and will
drift.
