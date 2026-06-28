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
with decades of production evidence, and the patterns compose into one coherent
stack: a smart core behind a typed protocol, exposed through deep modules and
published DTOs, with errors as values, per-session ownership, declarative hosts,
and automated fitness functions to keep the boundary honest as it evolves. That
stack is what VS Code, the Language Server Protocol ecosystem, rust-analyzer, and
most serious "shared core, several frontends" systems converge on.

This is a reference and a rule set, not a phased plan. The phased plan lives in
the decoupling PRD. When the two disagree, the decoupling PRD's specific audit
table wins; this document supplies the vocabulary and the rationale.

## Problem Statement

We keep hitting the same seven problems. Stated plainly:

1. **One runtime, three hosts.** The same launch, stream lifecycle, approval,
   human-input, and resume logic must serve three very different frontends
   without each host re-knowing the runtime's internal sequences.
2. **Shallow pass-throughs.** Boundary functions that rename or forward without
   hiding an invariant, which lengthen the call graph without simplifying it.
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
   misroutes across desktop windows.
7. **UI coupling.** Presentation that reaches into runtime data or invents state
   at render time, instead of receiving host-safe data declaratively.

A recurring eighth problem is keeping the boundary honest once it is built: an
import that was forbidden yesterday creeps back tomorrow unless a check fails the
build.

## How to Read This

Each pattern below is presented as: the **pattern** and where the industry
proved it, **how it maps to TeXRA** (the reference shape we already embody, plus
the current gap), and a **rule** a reviewer can apply. File references are
illustrative anchors, not an exhaustive list.

## Pattern 1: One Core, Many Hosts — Smart Core Behind a Typed Protocol

**Pattern and provenance.** The canonical answer to "one engine, several
frontends" is a typed protocol between a smart core and thin clients. Microsoft
built the **Language Server Protocol** (2016) and the **Debug Adapter Protocol**
for exactly this: one language server serves N editors instead of reimplementing
analysis per editor. **rust-analyzer** separates its analysis crate from the LSP
layer; the **TypeScript compiler API** backs `tsserver`, `tsc`, and editors
alike. The structural pattern underneath is **Hexagonal Architecture / Ports and
Adapters** (Alistair Cockburn, 2005): the core defines ports, each host is an
adapter. VS Code itself layers `common -> browser/node -> electron-sandbox` with
services resolved through dependency injection, and keeps platform code in the
thin outer layers.

**How it maps to TeXRA.** This is our spine and it is in good shape.
`@agent/runtime/*Commands` is the typed protocol; `src/hosts/AgentRuntimeHost.ts`
is the host event port; `packages/{extension,desktop,cli}` are the adapters;
`src/platform/` is the composition root in the VS Code service style. The
forbidden-import boundary makes the "thin client" rule explicit.

**Rule.** A host translates a user/IPC/CLI event into one runtime request and
renders the typed result. A host must not perform the runtime's internal
sequence. Adding a host should mean implementing ports and calling commands, not
copying another host's orchestration.

## Pattern 2: Deep Modules over Shallow Pass-Throughs

**Pattern and provenance.** **Deep Modules** (John Ousterhout, _A Philosophy of
Software Design_, 2018), which is the decoupling PRD's stated basis: a module
earns its existence by hiding a decision; maximize the ratio of hidden
implementation to interface surface. The negative form has names too. Martin
Fowler's _Refactoring_ catalogs the **Middle Man** smell and the **Remove Middle
Man** refactoring. In Domain-Driven Design terms (Eric Evans, 2003) our runtime
boundary is an **Anti-Corruption Layer**, and an ACL must _translate_; a
forwarding ACL is the degenerate case.

**How it maps to TeXRA.** Reference shapes that already hide a real invariant:
`requestRuntimeToolUseSnapshotResume` (the whole snapshot-resume transaction),
`streamResourceLifecycle.ts` (the complete deletion cleanup), `progressViewCommands.ts`
(multi-host visibility registration). The gap is the residue of `Runtime`-prefix
synonyms that forward one call with the same signature; the canonical example,
`setRuntimeStreamStatus`, was removed and is now guarded in
`check-runtime-boundaries.mjs`.

**Rule.** A boundary export must hide at least one of: an ordering, ownership,
cleanup, session-scope, persistence, or cross-host compatibility invariant. A
function that differs from the underlying one only by a `Runtime` prefix is not a
boundary; deepen it, merge it, or inline it.

## Pattern 3: Boundary Types — Information Hiding and Published DTOs

**Pattern and provenance.** The oldest pattern in the stack: David Parnas,
**"On the Criteria To Be Used in Decomposing Systems into Modules"** (1972) —
hide the design decisions most likely to change. At a boundary the modern forms
are the **Data Transfer Object** and DDD's **Published Language** (Evans): expose
a stable, narrow shape, never the internal aggregate. Alexis King's **"Parse,
don't validate"** (2019) sharpens it: at the seam, parse the rich internal type
into a narrow host-safe projection and hand that across; do not re-export the
internal type and trust callers to use only part of it.

**How it maps to TeXRA.** This is our least mature pattern and the dominant
remaining leak. Roughly 45 `export type Runtime* = <internalType>` aliases across
the runtime command modules (`executionRequests`, `historyCommands`,
`agentResolution`, `resumeCommands`) re-export the exact structural shapes the
import lint just forbade (`AgentConfig`, `TaskState`, `ExecutionMeta`/`ResultMeta`,
`AgentEntry`, the tool-use flow snapshot). The boundary hides the import line; the
information leaks intact, and hosts read and even construct the full shapes.

**Rule.** A boundary type is a projection the host actually needs, not an alias
of an internal type. If a host only reads three fields, publish those three
fields. The import lint cannot see this; it must be enforced by review and,
eventually, type-aware checks (Pattern 8).

## Pattern 4: Errors as Values, Defined Out of Existence

**Pattern and provenance.** Three complementary ideas. **Errors as values**:
make failure part of the type and handle it where it can be acted on, as in
Rust's `Result`, Haskell's `Either`, Go's explicit errors, and `neverthrow` in
TypeScript. Ousterhout's **"define errors out of existence"**: design the API so
the error cannot occur. Erlang/OTP's **"let it crash" with supervisors** (Joe
Armstrong): do not defensively catch everywhere; let failures propagate to one
layer that can handle them. The matching anti-patterns are well known too:
exception swallowing, and log-and-return-null that conflates absence with
failure.

**How it maps to TeXRA.** Mostly applied. Deep commands return typed outcomes
(`resumeCommands`, `textPolishCommands`, the follow-up notice result), and
`src/shared/progressView/backend/events/errorHandling.ts` is the supervisor that
centralizes swallow-and-log for event handlers. The residue was defensive: five
`.catch(() => {})` wrappers around `writeTerminalStatus`, which is contractually
non-throwing, so the handlers were unreachable and two of them were stealing
failures from an outer logger. Those were removed.

**Rule.** Prefer a typed result or a thrown error handled at a deliberate layer
over a local `try`. Do not guard a call that cannot throw. A `catch` that drops
the error must say why in a comment, and if an operator would ever need the
reason, it must log it.

## Pattern 5: Resist Premature Abstraction

**Pattern and provenance.** **YAGNI** (Extreme Programming) and the **Rule of
Three** (Fowler, _Refactoring_): do not abstract until the third occurrence.
Sandi Metz's **"the wrong abstraction"** (2016): a little duplication is far
cheaper than the wrong abstraction, because the wrong abstraction is expensive to
unwind. Ousterhout's corollary: classes should be deep, not numerous.

**How it maps to TeXRA.** The decoupling PRD's "No New Abstraction Without a
Deletion or an Invariant" rule is this pattern as policy, and the Phase 0.5
pass-through audit is its enforcement. A port with one implementation and one
caller, or a factory called exactly once (for example the
`SettingsGoalController` factory, since collapsed), is the smell.

**Rule.** Introduce a port when a second adapter needs it, not before. A factory
or wrapper called once should be inlined. Two similar shapes are not yet a shared
type; wait for the third, and confirm the similarity is structural rather than
coincidental.

## Pattern 6: Session-Scoped Ownership over Process Singletons

**Pattern and provenance.** The **Actor model** (Carl Hewitt, 1973; Erlang and
Akka in practice) and aggregate-root ownership: per-entity state lives with the
entity, never in a process-global. Operationally this is **dependency injection
over service location** and a single **Composition Root** (Mark Seemann) where
lifetimes are wired once.

**How it maps to TeXRA.** Largely applied: `SessionHandle` owns interrupts,
executions, coordinators, subscriptions, and flushers per session, and the
decoupling PRD's Runtime State Ownership audit classifies each long-lived
registry as truly-global, session-scoped, run-scoped, or host-UI state. One
residual module-level mutable remains the gap: the re-entrancy guard
`persistedWaitingDetections` in `followUpCommands.ts`. The former
last-writer-wins `activeHandler` singleton in
`packages/desktop/src/main/desktopAgentResume.ts` has been replaced with a
registration set, so several desktop windows can retain independent resume
ownership. That fix is the reference shape for this pattern: the process-level
dispatcher may exist, but ownership remains with each registered window.

**Rule.** Per-session and per-window state is owned by `SessionHandle` or a
window-scoped object and passed explicitly. A runtime command that touches a live
run accepts `session?: SessionHandle` and defaults to `currentSession()`. A new
module-level `let` or `Map` keyed by stream/window is a red flag unless it is
truly process-global.

## Pattern 7: Declarative UI — Functional Core, Imperative Shell

**Pattern and provenance.** Gary Bernhardt's **Functional Core, Imperative
Shell**: pure logic in the core, a thin imperative shell at the edge.
**Unidirectional data flow** (Flux/React and The Elm Architecture): state flows
down into pure views; views do not invent or mutate state during render.

**How it maps to TeXRA.** The CLI Ink TUI is the reference shape: ids are
assigned at ingestion, dedup is by stable id, renderers are props-in to JSX-out.
The gap is the progressView Lit formatters, which generate synthetic content-hash
ids at render time and stash copy text and parsed proposals in module-level
`Map`s (`copyContentStore`, `proposalInputStore`) that a reducer must then clear
on delete. That is the render-time workaround CLAUDE.md forbids.

**Rule.** Renderers are props-in to view-out, with no `Date.now()`, synthetic
ids, or dedup at render time. Carry the copy payload, the parsed proposal, and a
stable id on the entry DTO at ingestion. View-level toggles live in shared signal
state, not per-component local state.

## Pattern 8: Architecture Fitness Functions

**Pattern and provenance.** **Architecture fitness functions** (Neal Ford,
Rebecca Parsons, Patrick Kua, _Building Evolutionary Architectures_, 2017):
automated checks that fail the build when an architectural constraint is
violated, so the architecture cannot silently erode. The ecosystem tools are
**ArchUnit** (Java) and, for JS/TS, **dependency-cruiser**,
**eslint-plugin-boundaries**, and **ts-arch**.

**How it maps to TeXRA.** `scripts/check-runtime-boundaries.mjs` is a hand-rolled
fitness function: forbidden import paths, forbidden call patterns, deleted-export
guards, and controller host-neutrality, run locally and in CI. It is structurally
blind to type-level leakage (Pattern 3) because it matches import paths and
names, not types, and `knip` (dead code) is under-tuned. Maturing it means
type-aware boundary checks and a scoped `knip.json`.

**Rule.** Every boundary rule worth stating is worth enforcing automatically.
When a pass-through is deleted, guard its name. When a new forbidden import is
identified, add it to the checker in the same PR. A documented exception carries a
local comment and a link to this PRD or the decoupling PRD.

## Pattern-to-Problem Map

| Problem (from above)          | Pattern                                   | Proven by                                 |
| ----------------------------- | ----------------------------------------- | ----------------------------------------- |
| 1. One runtime, three hosts   | Smart core + typed protocol; Hexagonal    | LSP/DAP, rust-analyzer, VS Code layering  |
| 2. Shallow pass-throughs      | Deep Modules; Anti-Corruption Layer       | APoSD; DDD; Fowler "Remove Middle Man"    |
| 3. Type-level leakage         | Information Hiding; DTO / Published Lang. | Parnas 1972; DDD; "Parse, don't validate" |
| 4. Excessive try/except       | Errors as values; define-out; let-crash   | Rust/Haskell/Go; APoSD; Erlang/OTP        |
| 5. Over-layering              | YAGNI; Rule of Three; "wrong abstraction" | XP; Fowler; Sandi Metz                    |
| 6. Multi-session ownership    | Actor / aggregate; DI; composition root   | Hewitt/Erlang/Akka; Seemann               |
| 7. UI coupling                | Functional Core, Imperative Shell; UDF    | Bernhardt; Flux/Elm                       |
| 8. Boundary erosion over time | Architecture fitness functions            | Ford et al.; ArchUnit, dependency-cruiser |

## Where We Stand

| Pattern                     | Maturity | Reference shape we embody                  | Current gap                                 |
| --------------------------- | -------- | ------------------------------------------ | ------------------------------------------- |
| 1. Smart core + protocol    | Mature   | runtime commands, `AgentRuntimeHost`, lint | none material                               |
| 2. Deep modules             | Good     | resume/lifecycle/visibility commands       | residual `Runtime`-prefix forwards          |
| 3. Boundary DTOs            | Gap      | host-safe goal/queue projections           | ~45 `Runtime* = <internalType>` aliases     |
| 4. Errors as values         | Good     | typed outcomes, central `errorHandling.ts` | a few silent swallows that drop diagnostics |
| 5. No premature abstraction | Good     | pass-through audit, deletion-or-invariant  | a handful of single-call wrappers           |
| 6. Session ownership        | Good     | `SessionHandle`, ownership audit           | `persistedWaitingDetections`                |
| 7. Declarative UI           | Partial  | CLI Ink TUI                                | progressView render-time `Store` maps       |
| 8. Fitness functions        | Good     | `check-runtime-boundaries.mjs` in CI       | not type-aware; `knip.json` under-tuned     |

The two least-mature areas against the industry baseline are **Pattern 3**
(publish DTOs instead of aliasing internal types) and the tail of **Pattern 6**
(scope the last process-globals). Both are tracked in the decoupling PRD's
migration targets.

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
6. If it adds a boundary rule, add the matching fitness-function check in the
   same PR (Pattern 8).

## Non-Goals

Consistent with the decoupling PRD, these patterns do not call for:

- a single universal host UI framework spanning VS Code, Electron, and CLI;
- a generic message bus replacing typed progress-view commands;
- a dependency-injection framework (the composition-root pattern is enough);
- removing every process-global immediately, only the accidentally-shared ones;
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
