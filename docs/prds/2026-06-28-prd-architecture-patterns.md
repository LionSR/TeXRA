---
created: 2026-06-28
updated: 2026-06-28
---

# PRD: Industry-Tested Patterns for the Runtime/Host Boundary

## Overview

TeXRA runs one agent runtime behind three first-class hosts: the VS Code
extension, the Electron desktop shell, and the CLI/Ink TUI. The
`2026-06-27-prd-runtime-host-decoupling.md` PRD defines the program of work to
make that boundary deep. This document is its companion. It names the
industry-tested patterns behind that work, so contributors recognize the shape
we are aiming for instead of reinventing it, and can attach a known name and a
known failure mode to each decision.

The thesis is that the problems we face are not novel. Each is a named pattern
with prior production evidence, and the patterns compose into one coherent
stack: a smart core behind a typed protocol, exposed through deep modules and
published DTOs, with errors as values, per-session ownership, declarative hosts,
and automated fitness functions to keep the boundary honest as it evolves, all
reached by incremental migration rather than a rewrite. The same three-example
spine recurs whenever a single product grows several frontends: VS Code and the
Language Server Protocol ecosystem, rust-analyzer, and the TypeScript compiler
behind `tsserver`, `tsc`, and editors.

This is a reference and a rule set, not a phased plan. The phased plan lives in
the decoupling PRD. When the two disagree, the decoupling PRD's specific audit
table wins; this document supplies the vocabulary and the rationale.

## The Overriding Objective: As Few Layers as Possible

Every pattern below serves one end: the fewest layers the system can have while
each surviving layer earns its place. The operative principle is Ousterhout's
"different layer, different abstraction". A layer whose interface looks like the
layer beneath it is a pass-through and should not exist. Fewest layers is not one
god module (the decoupling PRD's first named risk is a runtime god-module); it is
deep modules plus the deletion of every layer that does not change the
abstraction. Depth and layer-count pull the same way: one deep command replaces
several shallow forwards.

For TeXRA the lean target is three hops per concern, not four or five:

1. **Host adapter** translates a UI / IPC / CLI event into one typed runtime
   request and renders the typed result (`packages/{extension,desktop,cli}`).
2. **Runtime command** is the deep module that owns the whole transaction
   (`@agent/runtime/*Commands`).
3. **Runtime internals** (services, storage, flows) stay hidden behind the
   command.

Two things are not automatic layers. A **controller** (`src/controllers/`) exists
only when several hosts share real host-neutral orchestration, the Rule-of-Three
case in Pattern 5; a controller that forwards to one runtime command is a
redundant fourth layer and collapses into the adapter or the command. A
**published DTO** (Pattern 3) is a shape on the wire, not a hop.

Reviewer test: count the hops between a host event and the runtime internal it
drives. If any hop presents the same abstraction as its neighbor, that hop is a
layer to delete. The success metric is layer-depth per concern trending toward
three, alongside the decoupling PRD's "fewer public runtime exports than
baseline".

## Problem Statement

We keep hitting the same seven problems. Stated plainly:

1. **One runtime, three hosts.** The same launch, stream lifecycle, approval,
   human-input, and resume logic must serve three very different frontends
   without each host re-knowing the runtime's internal sequences. When a host
   does re-know them, adding a single new runtime state transition forces
   parallel edits in extension, desktop, and CLI. That is Fowler's **Shotgun
   Surgery** / change amplification, and it is the core economic argument for
   the boundary (decoupling PRD Goal 4).
2. **Shallow pass-throughs.** Boundary functions that rename or forward without
   hiding an invariant, which lengthen the call graph without simplifying it.
   The invariant most often left exposed is a sequence the caller must replay
   (acquire queue, set `RESUMING`, drain, append, restore on failure, return
   `WAITING`); that is **temporal / sequential coupling**, and it cannot be
   independently tested while it lives in host code (decoupling PRD Goal 6).
3. **Type-level leakage.** Boundary modules that re-export the exact internal
   type they just forbade hosts from importing, so the seam is honest at the
   import line and dishonest at the type level.
4. **Excessive and defensive error handling.** Broad `try` blocks, swallowed
   errors, and `.catch` wrappers around code that cannot fail, which hide
   diagnostics and conflate "nothing to do" with "crashed".
5. **Over-layering.** Ports and wrappers introduced before a second
   implementation or second caller exists, adding indirection with no payoff.
6. **Multi-session ownership.** Per-window and per-session state stored in
   process-global module state, which works in the single-window extension and
   becomes a cross-window hazard on the desktop, where it cannot be disposed
   per window.
7. **UI coupling.** Presentation that reaches into runtime data or invents state
   at render time, instead of receiving host-safe data declaratively.

A recurring eighth concern is keeping the boundary honest once it is built: an
import that was forbidden yesterday creeps back tomorrow unless a check fails the
build, and the boundary is reached one deletion at a time, not in a rewrite.

## How to Read This

Each pattern below is presented as: the **pattern** and where the industry
proved it, **how it maps to TeXRA** (the reference shape we already embody with
verified file references, plus the current gap), and a **rule** a reviewer can
apply. File references are illustrative anchors, not an exhaustive list.

One unifying axis underneath all of these is **connascence** (Meilir Page-Jones,
_What Every Programmer Should Know About Object-Oriented Design_, 1995;
popularized by Jim Weirich): type-level leakage (Pattern 3) is connascence of
type across the boundary; "the host must replay a runtime sequence" (Problems 1
and 2) is connascence of execution (order) or algorithm; the `Runtime`-prefix synonyms are
connascence of name only. Naming the axis lets a reviewer say which kind of
coupling a change removes rather than only that "it leaks"; a PR should state
which connascence it removes.

## Pattern 1: One Core, Many Hosts Behind a Typed Protocol

**Pattern and provenance.** The canonical answer to "one engine, several
frontends" is a typed protocol between a smart core and thin clients. The
**Language Server Protocol** grew out of VS Code (2015) and was open-sourced and
standardized as a multi-editor protocol in 2016 by Microsoft with Red Hat and
Codenvy; the **Debug Adapter Protocol** was generalized out of VS Code's debug
protocol the same way. One language server (or debug adapter) serves N editors
instead of reimplementing analysis per editor. **rust-analyzer** separates its
`ide` analysis crate (the API boundary) from the `rust-analyzer` binary that
speaks LSP; the **TypeScript compiler** backs `tsserver`, `tsc`, and editors
alike. The structural pattern underneath is **Hexagonal Architecture / Ports and
Adapters** (Alistair Cockburn, the "Ports and Adapters" rename June 2005): the
core defines ports, each host is an adapter. VS Code itself layers
`common -> browser/node -> electron-sandbox` with services resolved through a
service locator, and keeps platform code in the thin outer layers.

Two sub-patterns make the thin-client claim concrete. The **Null Object** (Bobby
Woolf, _Pattern Languages of Program Design 3_, 1998) is a do-nothing adapter
that lets the same core run with no host attached. **Interface Segregation /
role interfaces** (Robert C. Martin's ISP; Fowler's "RoleInterface") shapes the
core's outward needs as narrow capability ports injected into shared backends,
rather than letting a backend import the owner of the capability.

**How it maps to TeXRA.** The typed protocol is `@agent/runtime/*Commands`; the
host event port is `src/hosts/AgentRuntimeHost.ts`; `packages/{extension,desktop,cli}`
are the adapters; `src/platform/platform.ts` is the composition root. The port
is a single `emit<K>(event, payload)` method (`AgentRuntimeHost.ts:28`), the
direct analogue of an LSP/DAP message channel: adapters implement transport, the
core owns semantics. `noopAgentRuntimeHost` (`AgentRuntimeHost.ts:35`) is the
Null Object: a drop-everything host that tests and non-interactive paths run a
full run against, which is the CLAUDE.md "headless parity is sacred" rule made
structural. That same Null Object is the reference partial host for
**Consumer-Driven Contract** testing (Martin Fowler, "ContractTest", 2011; Pact):
each adapter is exercised against the `AgentRuntimeHost` event contract, and
`ConversationPane.vitest.mts` is an existing host-side contract lock. The port's doc comment (`AgentRuntimeHost.ts:8-27`) enumerates a
two-tier contract: an essential streaming surface a host handles to observe a
run, and a frontend-bound group a thin client may ignore. That is the "render
the typed result, do not replay the internal sequence" rule written into the
type. The segregated capability ports are real: `src/shared/progressView/backend/runtimeStatus.ts`
and `src/controllers/progressView/progressRuntimePorts.ts` inject status and
session operations into shared backends instead of importing `StreamStatusService`
or `SessionHandle`. The forbidden-import boundary (`scripts/check-runtime-boundaries.mjs`)
makes the thin-client rule executable rather than aspirational (Pattern 8). One
deliberate, documented seam is narrower: `packages/cli/src/runtime/` is allowed
closer to runtime internals because it is partly a headless execution adapter
(decoupling PRD lines 698-701).

Honest nuance: `platform()` (`platform.ts:57`) is a process-global,
service-locator-style accessor, not constructor DI. That is the same
process-global tension Pattern 6 polices, held deliberately at the composition
root; Seemann, cited in Pattern 6, literally wrote "Service Locator is an
Anti-Pattern", so the two patterns are consistent only because the locator is
confined to one wired-once root.

**Rule.** A host translates a user/IPC/CLI event into one runtime request and
renders the typed result. A host must not replay the runtime's internal
sequence. Adding a host should mean implementing ports and calling commands, not
copying another host's orchestration. A core dependency on a host capability is
a narrow injected port, not an import of the capability's owner.

## Pattern 2: Deep Modules over Shallow Pass-Throughs

**Pattern and provenance.** **Deep Modules** (John Ousterhout, _A Philosophy of
Software Design_, 2018), the decoupling PRD's stated basis and already TeXRA
house style (AGENTS.md:384-396, "deepen shallow modules that merely pass data
through"): a module earns its existence by hiding a decision; maximize the ratio
of hidden implementation to interface surface. The negative form has names too.
Martin Fowler's _Refactoring_ catalogs the **Middle Man** smell, its fix
**Remove Middle Man**, and the inverse move **Hide Delegate**: deepening a
boundary _is_ Hide Delegate (the deep module hides the delegate chain), and a
shallow pass-through _is_ the Middle Man. In Domain-Driven Design terms (Eric
Evans, 2003) the runtime boundary is an **Anti-Corruption Layer** between two
**Bounded Contexts** (the runtime is one context, each host another), and an ACL
must _translate_; a forwarding ACL is the degenerate case.

**How it maps to TeXRA.** Reference shapes that hide a real invariant:

- `requestRuntimeToolUseSnapshotResume` (`resumeCommands.ts:271-313`) is the
  canonical deep module: one public call hides prepare, resume-from-snapshot,
  restore-drained-follow-ups-on-failure, and finish. The six-step sequence the
  decoupling PRD lists (lines 47-54) lives entirely inside this body.
- `releaseRuntimeDeletedStream(s)` (`streamResourceLifecycle.ts:38-93`) hides
  approval cleanup, queue release, coordinator cleanup, and goal removal behind
  one call, and encodes a cross-host compatibility invariant (lines 53-58,
  69-92): `process` approval scope for the single-window extension versus
  `session` scope so sibling desktop windows keep their pending approvals. That
  is the cross-host depth criterion made concrete.
- `historyCommands.ts:196` (`listRuntimeHistoryWorkspaceFiles`) shows the ACL
  translating, not forwarding: it normalizes stored records into host-safe
  runtime records rather than re-exporting the storage shape.

The call-level shallowness is largely resolved. The `Runtime`-prefix synonyms
that once forwarded one call with the same signature are deleted and guarded:
the canonical example `setRuntimeStreamStatus` is now a deleted-export entry
(`check-runtime-boundaries.mjs:486-493`) backed by the call-pattern guard at
line 312, and roughly thirty such names sit in the deleted-export registry
(lines 444-585). The remaining shallowness is type-level, not call-level, and is
handed to Pattern 3.

**Rule.** A boundary export must hide at least one of: an ordering, ownership,
cleanup, session-scope, persistence, or cross-host compatibility invariant. A
function that differs from the underlying one only by a `Runtime` prefix is not a
boundary; deepen it (Hide Delegate), merge it, or inline it (Remove Middle Man).

## Pattern 3: Boundary Types as Information Hiding and Published DTOs

**Pattern and provenance.** The oldest pattern in the stack: David Parnas, "On
the Criteria To Be Used in Decomposing Systems into Modules" (Communications of
the ACM 15(12):1053-1058, 1972), which coined information hiding: hide the design
decisions most likely to change. At a boundary the modern forms are distinct and
distinctly attributed. The **Data Transfer Object** is Martin Fowler's (_Patterns
of Enterprise Application Architecture_, 2002), with the "Transfer Object" /
"Value Object" precursor in _Core J2EE Patterns_ (Alur, Crupi, Malks, 2001).
**Published Language** is Eric Evans's (_Domain-Driven Design_, 2003): a stable,
narrow interchange shape at a context boundary. Alexis King's "Parse, Don't
Validate" (2019) sharpens the discipline: at the seam, parse the rich internal
type into a narrow host-safe projection once and hand that across; do not
re-export the internal type and trust callers to use only part of it.

Two reads sharpen the rule. The storage-facing half of this seam is the
**Repository** (Fowler, PoEAA 2002; Evans, DDD 2003): `historyCommands` and
`goalCommands` hide `@agent/storage`, `GoalStore`, and KV-store paths behind
collection-like operations so hosts never import persistence. Shaping a separate
read projection per consumer is **read-model / CQRS** shaping (Bertrand Meyer's
Command-Query Separation, 1988; CQRS framed by Greg Young and Udi Dahan around
2010); this is read-model shaping, not event-sourced CQRS. And the failure mode
where a host pulls the whole aggregate out and rebuilds it is the Ask half of
**Tell, Don't Ask** (Fowler's "TellDontAsk", 2013, crediting Andy Hunt and Dave
Thomas, the Pragmatic Programmers): tell the runtime to act, do not ask it for the
aggregate and re-derive state in the host.

**How it maps to TeXRA.** This is our least mature pattern, and the work is to
convert a known, counted set of aliases rather than to invent a capability. The
module already knows how to publish DTOs: of 45 `export type Runtime*` exports
across the runtime command modules, about 20 are genuine purpose-built
projections (`RuntimeFollowUpResult` at `followUpCommands.ts:36-44`,
`RuntimeModelSwitchResult`, `RuntimeHistoryDeleteExecutionResult`, the goal
projections), and `goalCommands.ts:9-74` is the textbook published-DTO /
parse-don't-validate shape: hand-authored projection interfaces, `toRuntimeGoal*`
narrow the persisted `Goal` to only the fields a host needs, and `GoalStore`
never leaves the module. `listRuntimeQueuedFollowUpMessages` returns `string[]`
(`followUpCommands.ts:54-58`), never the queue item type.

The leak is the other 25: pure single-line structural aliases. The densest site
is `executionRequests.ts:25-42` (eight aliases, including `RuntimeAgentConfig = AgentConfig`,
`RuntimeTaskState = TaskState`); more sit in `historyCommands.ts:28-31`,
`resumeCommands.ts:28`, `agentResolution.ts:33`, and `streamControl.ts:18`. The
precise failure is a Pattern 8 blind spot: the import lint forbids host imports
of `@agent/core/execution/TaskState` and `@agent/core/definition/AgentConfig`
(`check-runtime-boundaries.mjs:123,129,141`), but `RuntimeTaskState = TaskState`
re-exports those same shapes through an allowed path. Honest at the import line,
dishonest at the type level. And hosts then consume and reconstruct the full
shape: `buildCompileFixerConfig` (`ProgressFollowUpController.ts:378-393`) takes
a `RuntimeAgentConfig` and rebuilds a complete one via
`parseRuntimeToolUseAgentConfig({ ...originalConfig, ... })`, which is the Ask
anti-pattern in the flesh. When a published projection must change shape, evolve
it with the Zod union-plus-transform backward-compatibility pattern (CLAUDE.md
"Backward Compatibility with Zod"): new format first, legacy transforming to the
canonical shape at one entry point, so the published language stays
single-canonical for every host.

**Rule.** A boundary type is a projection the host actually needs, not an alias
of an internal type. If a host only reads three fields, publish those three
fields; if a host needs an action, give it a command, not the aggregate to
rebuild. The import lint cannot see a type alias; this must be enforced by review
and, eventually, type-aware checks (Pattern 8).

## Pattern 4: Errors as Values, Defined Out of Existence

**Pattern and provenance.** Three complementary ideas. **Errors as values**:
make failure part of the type and handle it where it can be acted on, as in
Rust's `Result`, Haskell's `Either`, Go's explicit errors, and `neverthrow` in
TypeScript. Ousterhout's "define errors out of existence" (_A Philosophy of
Software Design_, 2018, Ch. 10) and "exception aggregation" (section 10.7):
design the API so the error cannot occur, and where errors must be handled,
handle many call sites in one place. Erlang/OTP's "let it crash" (Joe Armstrong,
_Making reliable distributed systems in the presence of software errors_, 2003):
isolate failure to a boundary rather than defensively catching everywhere. TeXRA
takes the isolate-failure half of "let it crash", not the OTP restart half: an
OTP supervisor restarts a crashed process under a declared strategy; our central
handler logs and continues, so it is Ousterhout's exception aggregation, not a
supervisor.

**How it maps to TeXRA.** The flagship "define errors out of existence" shape is
`writeTerminalStatus` / `writeSessionDescription` (`executionLifecycle.ts:134-156`),
which carry an explicit contract comment ("Never throws, storage failures are
swallowed so callers' lifecycle logic always runs") and internalize the I/O
failure as a debug log. The API absorbs the error so no caller must handle it,
and that contract is exactly what made the call-site `.catch(() => {})` wrappers
dead: the branch deleting them (commit "refactor: drop dead .catch around
non-throwing writeTerminalStatus") removed wrappers around the contractually
non-throwing call. Errors as values appear as hand-rolled discriminated unions:
`RuntimeFollowUpOutcome` is `'sent' | 'queued' | 'dropped' | 'no_session'`
(`followUpCommands.ts`), with the same discriminated-union outcome pattern in
`RuntimeHistoryDeleteExecutionResult`, `RuntimeToolUseResumeDataResult`,
`RuntimeModelSwitchResult`, and `RuntimeTextPolishResult`, though the first is a
string-literal union and the rest are tagged object unions. These are deliberately not a `Result<T,E>` monad or
`neverthrow`; do not "modernize" them into a library dependency. The single
exception-aggregation boundary is `src/shared/progressView/backend/events/errorHandling.ts`:
`withEventErrorHandling` catches both sync throws and async rejections from
progress event handlers and routes them to one channel logger, in a VS Code-free
zone.

The residue is narrow. Most surviving `.catch(() => {})` sites are legitimate
fire-and-forget cleanup (temp-dir removal, session-registry teardown). The one
that violates the rule is `ProgressViewState.ts:385`: a `.catch(() => {})` on a
best-effort legacy disk migration with neither a why-comment nor a debug log.

**Rule.** Prefer a typed result or a thrown error handled at a deliberate layer
over a local `try`. Do not guard a call that cannot throw. When an operation is
genuinely non-critical bookkeeping, push the swallow into the callee behind a
documented "never throws" contract (the `writeTerminalStatus` model) rather than
wrapping each call site, which converts N defensive wrappers into one
defined-out-of-existence API. A `catch` that drops an error must say why in a
comment, and log it if an operator would ever need the reason.

## Pattern 5: Resist Premature Abstraction

**Pattern and provenance.** **YAGNI**, coined by Kent Beck on the Chrysler C3
project and formalized by Ron Jeffries (Fowler's bliki "Yagni", 2015): do not
build it until you need it. The **Rule of Three** (Fowler, _Refactoring_, which
credits Don Roberts: "Three strikes and you refactor"): do not abstract until the
third occurrence. Sandi Metz's "The Wrong Abstraction" (2016, expanding her
RailsConf 2014 talk "All the Little Things"): "duplication is far cheaper than
the wrong abstraction ... the fastest way forward is back", because the wrong
abstraction is expensive to unwind. Ousterhout's corollary against classitis:
classes should be deep, not numerous.

**How it maps to TeXRA.** The decoupling PRD's "No New Abstraction Without a
Deletion or an Invariant" rule (lines 201-213) is this pattern as policy, and the
Phase 0.5 Abstraction Reduction Plan (lines 215-265), which assigns each
pass-through exactly one of Deepen / Merge / Delete-inline / Temporary adapter,
is its enforcement. The Rule of Three is applied symmetrically, anchored in
CLAUDE.md's own "when factories ARE justified: called from multiple locations"
rubric. One host means inline: the settings goal controller is constructed
directly, `new SettingsGoalController()` (`SettingsViewMessageHandler.ts:197`),
with no factory. Two hosts means keep the factory: `MainViewStartupControllerFactory`,
`SettingsMemoryControllerFactory`, `SettingsModelSelectionControllerFactory`, and
`SettingsAgentControllerFactory` are each called from both the extension and the
desktop host, so they are the justified case, not a smell. A scan of the current
tree finds no surviving single-call controller factory; this pattern is near
mature.

**Rule.** Introduce a port when a second adapter needs it, not before. A factory
or wrapper called once should be inlined. Two similar shapes are not yet a shared
type; wait for the third and confirm the similarity is structural rather than
coincidental. When an abstraction proves wrong, re-inline the duplication ("the
fastest way forward is back") rather than adding another parameter to rescue it.

## Pattern 6: Session-Scoped Ownership over Process Singletons

**Pattern and provenance.** The **Actor model** (Carl Hewitt, Peter Bishop,
Richard Steiger, "A Universal Modular ACTOR Formalism for Artificial
Intelligence", IJCAI 1973; Erlang and Akka in practice) and **aggregate-root**
ownership (Evans, _Domain-Driven Design_, 2003): per-entity state lives with the
entity, never in a process-global. Operationally this is **dependency injection
over service location** and a single **Composition Root** (Mark Seemann, ploeh
blog, 2011, and Seemann and van Deursen, _Dependency Injection Principles,
Practices, and Patterns_, 2019; see also his "Service Locator is an
Anti-Pattern", 2010) where lifetimes are wired once.

**How it maps to TeXRA.** `SessionHandle` is the aggregate root / actor: it owns
interrupts, executions, coordinators, subscriptions, and flushers as readonly
per-session fields (`SessionHandle.ts:72-80`), constructed fresh per session
(lines 90-116). The class doc comment states the exact failure mode it guards
against: a process singleton "would leak interrupts or cross-session clearAll
sweeps" (`SessionHandle.ts:21`). `dispose()` / `disposeWhenIdle()` (lines
181-221) bind cleanup to the entity's lifetime, deferring teardown while
executions are active. The run-scoped default `currentSession()`
(`SessionHandle.ts:282`) is consumed across the command surface (`streamControl.ts:55,76`;
`runCoordinatorCommands.ts:32,41,50,58`; `streamResourceLifecycle.ts:40,63`;
`modelSwitch.ts:34,53`; `manualCompaction.ts:45`; `executionQueries.ts:16`). The
decoupling PRD's Runtime State Ownership audit (lines 1632-1655) classifies every
long-lived runtime registry as truly-global, session-scoped, run-scoped, or host-UI
state.

The remaining audited module-level mutable is `desktopAgentResume.ts`:
`registeredHandlers` (line 8) is a process-wide registry of window handlers.
This is no longer the old last-writer-wins singleton: registration returns a
disposer, `tryResumeDesktopStream` iterates all handlers in reverse registration
order, and `isDesktopResumeInFlight` aggregates across them. It is acceptable as
a process router while stream ids are globally unique and handlers self-filter;
if resume ownership becomes window-keyed, this registry should move behind an
explicit window resume router.

The previous follow-up debt is now the reference shape. The old
`persistedWaitingDetections` module-global lock has moved to
`SessionHandle.followUps` as `SessionFollowUpState`; `followUpCommands` resolves
the supplied/default session and claims a persisted-WAITING probe through that
session. The boundary checker now rejects reintroducing the old module-global
lock name.

**Rule.** Per-session and per-window state is owned by `SessionHandle` or a
window-scoped object and passed explicitly. A runtime command that touches a live
run accepts `session?: SessionHandle` and defaults to `currentSession()`. A new
module-level `let` or `Map`/`Set` keyed by stream/window is a red flag unless it
is truly process-global or audited as session-scoped-by-invariant.

## Pattern 7: Declarative UI with a Functional Core and Imperative Shell

**Pattern and provenance.** Gary Bernhardt's "Functional Core, Imperative Shell"
(Destroy All Software screencast, 2012, with the companion "Boundaries" talk):
pure logic in the core, a thin imperative shell at the edge. **Unidirectional
data flow** (Facebook's Flux, 2014, and The Elm Architecture by Evan Czaplicki):
state flows down into pure views; views do not invent or mutate state during
render. The testability rationale is the **Humble Object** (Gerard Meszaros,
_xUnit Test Patterns_, 2007; precursor Michael Feathers' "Humble Dialog Box",
2002): a props-in-to-view-out renderer is humble, so all testable logic moves to
the ingestion layer, where invariants can be locked without a terminal. TeXRA's
own CLAUDE.md "Stateless renderers" and "Render-Time Workarounds (Anti-pattern)"
sections are this pattern stated as house rule.

**How it maps to TeXRA.** The CLI Ink TUI is the reference shape, and it is
test-locked. Ids are assigned at ingestion, not render: `entryId` is minted as a
stream-scoped key (`transcript.ts:57,80`) and the local-entry id at line 121.
Finalization is a state transition at ingestion (`{ ...entry, finalized: true }`,
`subscribeStreamLog.ts:288`), so the renderer only filters on `entry.finalized`.
Scrollback dedups purely by stable `entry.id`
(`StaticConversationTranscript.tsx:249,306,317`), no content comparison and no
synthetic id at render. `ConversationPane.vitest.mts:136-198,244-275` asserts
exactly this: finalized-only scrollback, dedup and order by stable id. Honesty
caveat: the CLI is the reference but not pristine. The live-append path
`appendAssistantTranscriptIfMissing` (`transcript.ts:59-76`) still keeps a
content-comparison dedup fallback; it is at ingestion, not render, so it is the
milder case, but it is the "dedup comparing content" smell CLAUDE.md names and
should be retired.

The gap is the progressView Lit formatters. Three module-level stores must be
garbage-collected by the delete reducer, `copyContentStore`, `proposalInputStore`,
and `resolvedProposalIds`, which `DELETE_STREAM` / `DELETE_ALL` clear through
`clearCopyContentStore()`, `clearProposalInputStore()`, and
`clearResolvedProposalIds()` (`streamLifecycleSlice.ts`). Only the first two are
render-minted: their content-hash ids are side effects of the html formatters
(`messageFormatters.ts`, `htmlBuilders.ts`, `toolFormatters.ts`), while
`resolvedProposalIds` is a permission out-of-order guard. A separate store,
`pendingDescriptions` (`streamMetaSlice.ts`), is inter-slice plumbing consumed on
read rather than cleared on delete; it too belongs on the entry DTO at ingestion.
A renderer that needs a reducer to clean up after it is the inversion this
pattern forbids.

**Rule.** Renderers are props-in to view-out, with no `Date.now()`, synthetic
ids, or dedup at render time. Carry the copy payload, the parsed proposal, and a
stable id on the entry DTO at ingestion (the way `ConversationEntry.id` is minted
in `transcript.ts`), so the four module-level stores and their clear-on-delete
reducer calls disappear. Diagnostic: if a reducer has to clear a renderer's `Map`
on delete, the id and payload belong on the DTO, not in a render-time store.
View-level toggles live in shared signal state, not per-component local state.

## Pattern 8: Architecture Fitness Functions

**Pattern and provenance.** **Architecture fitness functions** (Neal Ford,
Rebecca Parsons, Patrick Kua, _Building Evolutionary Architectures_, O'Reilly,
1st ed. 2017; 2nd ed. 2022 with Pramod Sadalage, subtitled "Automated Software
Governance"): "any mechanism that provides an objective integrity assessment of
some architectural characteristic", borrowing the term from evolutionary
computing. The defining property is that the check fails the build, so the
architecture cannot silently erode. The ecosystem tools are **ArchUnit** (Java),
and for JS/TS **dependency-cruiser**, **eslint-plugin-boundaries**, and
**ts-arch / ArchUnitTS**.

**How it maps to TeXRA.** TeXRA runs a family of hand-rolled fitness functions,
not one script: `check:runtime-boundaries`, `check:cli-architecture`,
`check:cli-orchestration-manifest`, `check:extension-package-invariants`,
`check:vsix-contents`, and `check:desktop-electron-binary` (package.json:49-58).
The runtime checker (`scripts/check-runtime-boundaries.mjs`) carries
`FORBIDDEN_IMPORTS` (lines 20-249), `FORBIDDEN_PATTERNS` (251-412), and
`DELETED_RUNTIME_EXPORTS` guards (442-585), with controller host-neutrality
enforced separately via `CONTROLLER_FORBIDDEN_IMPORTS` (414-425) scoped to
`src/controllers` (line 764).

Two real gaps. First, it is type-blind by construction: `importSourcePattern`
(line 656) matches import source strings and `deletedRuntimeExportPattern` (line 659) matches identifier names; neither resolves types, so the Pattern 3 leak
(`export type Runtime* = InternalType`) is structurally invisible. The cited
off-the-shelf tools share this blind spot: dependency-cruiser,
eslint-plugin-boundaries, and ts-arch are import-graph / path-based, so none of
them would catch a type alias either. Closing the Pattern 3 gap needs a
TypeScript compiler-API / ts-morph rule that resolves the alias target, not an
import-path linter. Second, several checks never gate CI: only
`check:runtime-boundaries` (`ci.yml:94`), `check:extension-package-invariants`
(`ci.yml:97`), and `check:vsix-contents` (`ci.yml:127`) fail the build.
`check:dead-code` (knip) and the CLI host-import boundary `check:cli-architecture`
run only as local npm scripts, and knip is under-tuned: `ignoreDependencies` and
`ignoreBinaries` are both `".*"` (`knip.json:3-4`), disabling its dependency and
binary detection. A fitness function that never fails the build cannot prevent
erosion.

**Rule.** Every boundary rule worth stating is worth enforcing automatically, and
a fitness function only governs if it fails the build. When a pass-through is
deleted, guard its name. When a new forbidden import is identified, add it to the
checker in the same PR. Type-alias leakage needs a type-resolving (ts-morph)
rule, not a path matcher. Wire the dead-code and CLI-boundary checks into CI, and
scope `knip.json` away from `".*"` so they actually gate. A documented exception
carries a local comment and a link to this PRD or the decoupling PRD.

## Pattern 9: Strangler Fig, Incremental Migration

**Pattern and provenance.** **Strangler Fig Application** (Martin Fowler,
"StranglerFigApplication", 2004; renamed from "Strangler Application" in 2019):
grow a new structure around the old one and retire the old path increment by
increment, never in a rewrite. It is the migration engine that reaches every
destination pattern above, the connective tissue between Pattern 2 (deepen a
boundary) and Pattern 8 (guard what you deleted).

**How it maps to TeXRA.** The companion decoupling PRD is literally a strangler
run: it deprecates and deletes pass-throughs one at a time, guards each deleted
name so it cannot return (`DELETED_RUNTIME_EXPORTS` in
`check-runtime-boundaries.mjs:442-585`), and lets the typed runtime surface grow
around the old call sites until they are gone. Its Phase 0.5 classification
includes a "Temporary adapter with a named removal milestone" outcome, and a
rewrite is an explicit Non-Goal. The deleted-export guard is what makes the
increment safe: a deleted synonym (for example `setRuntimeStreamStatus`) fails
the build if reintroduced, so the strangled path cannot grow back.

**Rule.** Migrate by deletion, not rewrite. Each step either deletes a
pass-through or moves an invariant, and either guards the deleted name or adds an
invariant test in the same PR. When a temporary adapter is unavoidable, give it a
named removal milestone rather than leaving it permanent.

## Pattern-to-Problem Map

| Problem (from above)                                   | Pattern                                                                  | Proven by                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| 1. One runtime, three hosts                            | Smart core + typed protocol; Hexagonal; Null Object; role interfaces     | LSP/DAP, rust-analyzer, VS Code; Woolf; ISP              |
| 2. Shallow pass-throughs                               | Deep Modules; ACL; Hide Delegate                                         | Ousterhout; Evans; Fowler "Remove Middle Man"            |
| 3. Type-level leakage                                  | Information Hiding; DTO / Published Language; Repository; Tell-Don't-Ask | Parnas 1972; Fowler DTO; Evans; King 2019                |
| 4. Excessive try/except                                | Errors as values; define-out; exception aggregation                      | Rust/Haskell/Go; Ousterhout Ch.10; Erlang "let it crash" |
| 5. Over-layering                                       | YAGNI; Rule of Three; "wrong abstraction"                                | Beck/Jeffries; Fowler/Roberts; Metz                      |
| 6. Multi-session ownership                             | Actor / aggregate root; DI; composition root                             | Hewitt/Bishop/Steiger; Evans; Seemann                    |
| 7. UI coupling                                         | Functional Core, Imperative Shell; Humble Object; UDF                    | Bernhardt; Meszaros; Flux/Elm                            |
| 8. Boundary erosion over time                          | Architecture fitness functions                                           | Ford/Parsons/Kua; ArchUnit, dependency-cruiser           |
| Cross-cutting: reaching the boundary without a rewrite | Strangler Fig                                                            | Fowler 2004                                              |

## Where We Stand

| Pattern                     | Maturity | Reference shape we embody                                                     | Current gap                                                                                                              |
| --------------------------- | -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1. Smart core + protocol    | Mature   | typed port `AgentRuntimeHost`, `noopAgentRuntimeHost`, capability ports, lint | none material                                                                                                            |
| 2. Deep modules             | Good     | resume/lifecycle/visibility commands                                          | call-level forwards deleted and guarded; residue is type-level (Pattern 3)                                               |
| 3. Boundary DTOs            | Partial  | ~20 host-safe goal/queue/result DTOs                                          | 25 of 45 `Runtime*` exports are structural aliases; hosts rebuild aggregates                                             |
| 4. Errors as values         | Good     | typed outcomes, `writeTerminalStatus` contract, central `errorHandling.ts`    | one diagnostic-dropping swallow (`ProgressViewState.ts:385`)                                                             |
| 5. No premature abstraction | Good     | pass-through audit, deletion-or-invariant                                     | near mature; no surviving single-call controller factory found                                                           |
| 6. Session ownership        | Good     | `SessionHandle`, ownership audit                                              | no known accidental session-global in this slice; desktop resume registry remains an intentional process router to watch |
| 7. Declarative UI           | Partial  | CLI Ink TUI (test-locked)                                                     | three progressView stores the delete reducer must clear; CLI ingestion-time content dedup                                |
| 8. Fitness functions        | Good     | family of `check:*` scripts                                                   | type-blind regex; dead-code and CLI-boundary checks not in CI; `knip.json` `".*"`                                        |
| 9. Strangler Fig            | Good     | deleted-export guards, Phase 0.5 plan                                         | temporary adapters need named removal milestones                                                                         |
| Layer depth (objective)     | Good     | three-hop adapter / command / internals spine                                 | occasional pass-through controllers to collapse into the adapter or the command                                          |

The two least-mature areas against the industry baseline are **Pattern 3**
(convert the 25 internal-type aliases into published projections; the module
already publishes about 20 good DTOs) and **Pattern 7** (reduce render-time UI
state reconstruction in the progress view). Pattern 6 is now in the watch state:
new stream/window keyed mutable state should be rejected unless it is owned by
`SessionHandle`, a window object, or an explicitly documented process router.

## Adoption Rules

A PR that touches the runtime/host boundary should be expressible in this
vocabulary. In addition to the decoupling PRD's review checklist:

1. Name the pattern the change advances and the failure mode it removes.
2. If it adds a boundary type, confirm it is a published projection, not an
   internal-type alias (Pattern 3).
3. If it adds error handling, prefer a typed result or a deliberate handling
   layer over a local `try` (Pattern 4).
4. If it adds an abstraction, name the second caller or implementation that
   justifies it (Pattern 5).
5. If it adds per-session state, show where the session owns it (Pattern 6).
6. If it adds a boundary rule, add the matching fitness-function check, wired
   into CI, in the same PR (Pattern 8).
7. If it removes a pass-through, guard the deleted name or add an invariant test
   in the same PR (Pattern 9).
8. Apply the hop-count reviewer test from The Overriding Objective: delete any
   hop that presents its neighbor's abstraction.

## Non-Goals

Consistent with the decoupling PRD, these patterns do not call for:

- a single universal host UI framework spanning VS Code, Electron, and CLI;
- a generic message bus replacing typed progress-view commands;
- a dependency-injection framework (the composition-root pattern is enough);
- replacing the hand-rolled discriminated-union results with a `Result`/`neverthrow`
  library;
- removing every process-global immediately, only the accidentally-shared ones;
- a big-bang rewrite of the boundary (Pattern 9 is incremental by design);
- rewriting flows, schemas, or host-specific affordances to look identical.

The aim is shared runtime semantics with host-specific presentation, expressed in
named patterns so the boundary stays recognizable as it grows.

## Relation to Existing Documents

This PRD supplies the pattern vocabulary for, and defers on specifics to:

- `docs/prds/2026-06-27-prd-runtime-host-decoupling.md` (the phased program and
  audit table);
- `docs/proposals/session-handle-7d-design.md` (session ownership);
- `docs/proposals/dependency-injection-cleanup.md` (composition roots and
  dependency visibility).
