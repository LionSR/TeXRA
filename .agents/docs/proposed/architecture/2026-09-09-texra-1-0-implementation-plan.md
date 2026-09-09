# TeXRA 1.0: direct implementation and retirement plan

Status: proposed — implementation sequence under the accepted 1.0 policy.

This assessment examines `main` at `9ae9ab875b` on 2026-09-09. The
[repository policy](../../../../AGENTS.md#texra-10-direction) establishes the
release direction: projects, fresh SQLite application state, Effect-native
execution, no legacy JSON migration, and no temporary replacement systems.
The policy is accepted; the specific design choices below are recommendations.

## 1. Release separation

`release/0.40` has been created locally and on GitHub at `v0.40.10`
(`d64cfc5006418a2d1e997eaf4aa1b9bf6b522e91`). It preserves the released
architecture and storage format for existing users. `main` is the 1.0 line.

Backport fixes by their effect on released behavior, not by their commit
title. Several recent fixes repair defects introduced by unreleased redesigns.
Those are not maintenance-release changes. When a useful fix is mixed into a
large PR, extract the necessary change and its regression test, record the
original commit, and validate against the release branch's dependencies.
Do not merge the 1.0 development line into the maintenance branch.

The first prepared backport batch contains:

| Change                                                      | Source                                           | Release-specific treatment                                          |
| ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Keep document replacement rules out of helper output        | `84737d090e`, from #11997                        | Adapt the desktop caller and test session setup to 0.40 APIs.       |
| Fit VS Code model output allowance to the available context | `373b05b814`, #12008, and follow-up `71b8565114` | Include the follow-up so unsupported tools do not affect the count. |
| Isolate cached credentials by their secret store            | `6709198ddf`, from #11997                        | Extract only `apiProviders.ts` and its existing regression suite.   |

Further candidates require separate, focused backports: canonical-path checks
for workflow inputs and partial Google attachment failures from #11943;
preserving the CLI conversation when resume is refused; and removing arXiv
staging directories after failures. The first two extend earlier release
fixes rather than duplicating them. The arXiv fix should use the release's
existing control flow, without importing the later Effect rewrite.

## 2. What the implementation actually contains

The SQLite session store and shared session view are substantial completed
work. They should be retained. However, they do not yet replace the execution
engine or execution persistence.

- [`executeAgent.ts`](../../../../src/agent/runtime/executeAgent.ts) still
  calls `runToolUseFlow` and `runReflectionFlow` from an asynchronous body
  enclosed by Effect.
- [`runToolUseFlow.ts`](../../../../src/agent/implementations/flows/tooluse/runToolUseFlow.ts)
  obtains an execution KV store and constructs a persisted flow. Reflection
  uses `RoundPersistedFlow`.
- [`persistedFlow.ts`](../../../../src/agent/node/persistedFlow.ts) stores a
  graph cursor through `ExecutionKVStore`. Reimplementing that KV interface
  with SQLite would retain the old engine and checkpoint representation.
- [`AgentLaunchContext.ts`](../../../../src/agent/runtime/AgentLaunchContext.ts)
  still constructs models through the old `ModelFactory` and handler classes.
  [`packages/llm/src/turn.ts`](../../../../packages/llm/src/turn.ts) defines the
  new Effect/Stream model contract, but the provider package is not yet used
  by the production agent execution path at this revision.
- [`sessionLayer.ts`](../../../../src/controllers/session/sessionLayer.ts),
  [`SessionView.ts`](../../../../src/controllers/session/SessionView.ts), and
  the shared session fold already provide useful scoped services and a common
  view for the hosts. Replacing the execution engine does not require another
  UI rewrite.

## 3. Retirement boundary

These are removal targets, not an invitation to improve their internal design.

| Current mechanism                                               | Final treatment                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KVStore` and `ExecutionKVStore`                                | Delete with their execution-state consumers. Introduce typed Effect database operations directly; do not implement the old interface over SQL.           |
| `PersistedFlow`, graph-cursor checkpoints, `RoundPersistedFlow` | Replace with the final Effect loops and durable model/tool/workflow state, then delete the old interpreter and its dedicated tests.                      |
| File-based `executionLease`                                     | Replace ownership admission and write checks with database transactions; delete lease files, polling, legacy readers, and compatibility writes together. |
| Application-state uses of `JsonStore`                           | Move host state and mutable application records to SQLite. Do not migrate their old contents.                                                            |
| Legacy workspace-directory rename and sidecar registry          | Remove when selecting fresh 1.0 state locations and project identity.                                                                                    |
| JSON-state file locks, caches, directory indexes, atomic writes | Delete when their state owner is replaced, rather than converting these mechanisms to Effect first.                                                      |
| `scripts/native-cleanup`                                        | Remove with the final generated-file ownership change, including the loader, binaries, build jobs, packaging hooks, and addon-only tests.                |
| Old model-handler hierarchy                                     | Retire after both agent execution and helper calls use the new provider contract.                                                                        |

Some similarly named facilities have independent consumers:

- `fileLocks` also coordinates copying bundled agent directories. Prefer
  reading immutable packaged defaults and separate user-managed agent files
  if that satisfies the product requirements; this removes the shared copy,
  synchronization marker, and lock together.
- `writeAtomic` also writes Markdown memory files, CLI input history, and
  inquiry records. History and inquiry metadata are application state;
  deliberately editable memory files require a separate file-format decision.
  Atomic replacement is not inherently obsolete, nor is it appropriate for
  every research file: replacing a symlink changes its meaning.
- `JsonStore` also serves explicit configuration and credentials. Preserve a
  deliberate configuration format where useful. Preserve credential protection
  and host secret providers; the storage change must not silently replace
  encrypted credentials with ordinary plaintext database rows.
- `leaseOwnerLiveness.ts` is already used by `Database.ts`. Deleting file
  leases does not remove the need to determine whether another process still
  owns an execution.

## 4. Recommended implementation order

### A. Establish fresh state and project identity

Choose one application-state namespace for 1.0, with global state and
project-scoped databases, consistently resolved by all three hosts. Start with
the existing per-root database design; avoid adding an unrelated persistence
framework. Keep the database location distinct from the research folder.

This must precede removal of compatibility readers. The current
[`nodeStorage.ts`](../../../../src/platform/defaults/nodeStorage.ts) still
defaults to `~/.texra`, and
[`workspaceStorage.ts`](../../../../src/platform/defaults/workspaceStorage.ts)
automatically renames a legacy workspace directory from `getStoragePath()`.
A fresh reader alone would not prevent old user data from being touched.

Complete this change with removal of that rename, old-state discovery, and
legacy-only schemas and tests. Verify that opening 1.0 leaves a representative
0.40 state directory unchanged and creates only current-format state.

### B. Replace execution persistence and execution together

Define the durable facts needed to start, stop, resume, and inspect a run:
configuration, completed model turns, tool outcomes, workflow progress,
parent/child relationships, and ownership. Use explicit schemas and queries.
The current event store is a foundation; its two-table layout is not a reason
to encode every setting or mutable record as an event. Add ordinary tables
where they make the final model simpler while keeping related writes atomic.

Connect the provider package to scoped Effect tool-use and reflection loops.
Commit a completed response before dispatching its tools, and commit the
observed tool outcomes before continuing. Specify what happens if a process
dies during an external operation: a database transaction cannot make an
arbitrary external side effect exactly-once.

Replace each complete execution path through its callers, then delete its old
flow, checkpoint, KV, and file-lease dependencies. A completed path must have
one implementation and one persistent authority. Staging work for review is
reasonable; shipping a second engine, dual writes, or a temporary SQL-KV
adapter is not.

Verify fresh launch, interruption, approval waiting, resume after process
exit, competing owners, child results, and provider continuation. Extend the
existing behavioral suites where they protect these contracts; remove tests
whose only subject is the retired engine or format.

Write the new runtime tests as Effect programs with `@effect/vitest` and
scoped test layers. Use the Effect test clock to advance retries and deadlines
deterministically; exercise failure, interruption, and resource release through
the same Effect scopes used in production. Use `it.live` for tests requiring
real I/O or real time. Avoid rebuilding the old Promise orchestration in test
helpers or replacing every internal service with a mock. Pure transformations
and schemas can retain ordinary Vitest tests. Tests of released 0.40 fixes
continue to use that branch's existing runtime and test conventions.

### C. Finish application records and generated-file ownership

Move remaining host state, input history, inquiry metadata, and mutable
registries into the final database model. Keep configuration, credentials,
research files, and exports explicit in the ownership model.

Run directories currently contain generated TeX/PDF outputs, original
snapshots, and workspace links as well as obsolete state. Therefore moving
JSON records into SQLite does not make those directories disposable.

Prefer an ownership model where deleting a conversation deletes its database
records, while exported research outputs remain ordinary project files.
Application-owned payloads that require atomic deletion can reside in SQLite
where practical. External tools still need scratch files; define their
lifetime and permissible location explicitly.

The existing native addon holds directory handles and confines deletion under
concurrent directory replacement. A path check followed by recursive removal
does not establish the same property. Resolve the final file ownership and
deletion contract before choosing its implementation; do not build another
temporary cleanup framework. If SQL-owned files remain external, interruption
between database changes and filesystem operations needs a durable retry
policy. SQLite transactions cover database contents, not independent file
deletion ([SQLite transaction guarantees](https://www.sqlite.org/transactional.html)).

Remove the addon and its entire build/package dependency in this complete
change. Keep unrelated native dependencies, such as terminal support, when
they still serve the product.

### D. Rename the working unit coherently

This can proceed independently once project identity is settled. Rename the
desktop registry, messages, state keys, shared display record, renderer
workbench, and interface text together. The main locations are
`desktopPapers.ts`, `desktopPaperMessages.ts`, `hostSnapshot.ts`,
`hostSnapshotSource.ts`, `paperWorkbench.ts`, and `taskShell.ts`.

Adopt the new internal names directly, without aliases or a desktop-state
migration. Retain **paper** for scholarly documents and literature operations.
Preserve the existing per-folder session and resource ownership behavior.

## 5. Work to stop scheduling

Use supported upstream facilities before implementing infrastructure. Evaluate
Effect's database, concurrency, process, filesystem, and resource-management
facilities against the final product requirements and the version actually
used by the hosts. Prefer direct adoption over a custom equivalent or an
adapter preserving the old API. Keep a custom implementation only for a
demonstrated requirement the supported facilities cannot meet. Upgrading the
supported stack and deleting redundant code is preferable to extending an
obsolete internal contract.

Do not fund another round of Effect conversions inside the retiring JSON
store, file lease implementation, persisted graph, or old model handlers
merely to reduce a count of Promise calls. Convert durable consumers to their
final services. A wrapper count is not evidence that execution has changed.

Do not develop JSON import manifests, history converters, old-format readers,
or a temporary generated-file cleanup implementation. Existing defects on the
released line can be fixed there without expanding those systems on `main`.

Earlier proposals remain useful as historical evidence, but their migration
checklists and adapter suggestions are not current work orders. This plan
supersedes those items for 1.0. Before implementing a subsystem, replace its
obsolete acceptance criteria with the current contract rather than adding yet
another conflicting amendment. Architecture checks must protect ownership and
correctness, not force preservation of a retired class or filename.

## 6. Release readiness

The current release workflow excludes prereleases from publishing jobs and
uses ordinary `npm publish` for stable CLI releases. Define and verify an
explicit 1.0 preview distribution before asking existing users to test it;
creating a version tag alone does not establish a preview channel.

The 1.0 release should require: fresh-state isolation, functioning execution
through the final provider/runtime path on each host, tested interruption and
reopening behavior, coherent project terminology, removal of the old state
and native-cleanup machinery, and clear instructions that old application
state is not imported. Removing legacy migration does not remove the need to
identify the current database format and reject unsupported state clearly.

## 7. Open PR disposition at the decision point

The seven pre-existing open PRs inspected on 2026-09-09 all target `main`.
Creating the maintenance branch did not move, close, or merge them. The
recommendations below concern their fit with 1.0; they are not substitutes for
code review or completed validation. Large diffs were inspected selectively.

| PR                                                                                 | Recommended disposition                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#12108: execution metadata in SQLite](https://github.com/LionSR/TeXRA/pull/12108) | Keep as a draft and revise against the final storage contract. Its description already drops JSON import and requires fresh-state isolation. It adopts the official Effect SQLite client and removes metadata accessors, but retains file checkpoints, delegation state, file leases, and native cleanup. Preserve useful SQL work; do not describe this intermediate state as completed 1.0 persistence or expand the remaining doomed machinery. |
| [#12106: Effect filesystem reads](https://github.com/LionSR/TeXRA/pull/12106)      | Keep and reconcile with current main. It uses the official filesystem layer and scoped reads for retained memory files; it is not a JSON migration system.                                                                                                                                                                                                                                                                                         |
| [#12005: bounded conversation readers](https://github.com/LionSR/TeXRA/pull/12005) | Keep. Bounded SQL reads, controlled frame delivery, and scoped transcript interests serve the final session design. Review the proposed memory and frame limits as product behavior.                                                                                                                                                                                                                                                               |
| [#12068: runtime measurements](https://github.com/LionSR/TeXRA/pull/12068)         | Keep useful measurement evidence; revise the framing. Record the measured commit and workload, rename the working unit to project, and remove an obsolete planning gate if it would delay replacement.                                                                                                                                                                                                                                             |
| [#12109: filesystem experiment](https://github.com/LionSR/TeXRA/pull/12109)        | Revise. The custom filesystem experiment was reverted; the final PR contains a report, benchmark, and comment correction. Keep useful evidence, but remove stale dependency claims and conclusions that use retiring run/lease files to justify new infrastructure.                                                                                                                                                                                |
| [#12067: Astra pricing](https://github.com/LionSR/TeXRA/pull/12067)                | Prioritize a focused maintenance backport. The released handler lacks long-context tier selection, while its pricing calculator already supports it. The reasoning clamp is already fixed in 0.40.10; the PR title should describe the pricing change alone. Carry the same pricing behavior into the final provider implementation.                                                                                                               |
| [#12134: desktop log severity](https://github.com/LionSR/TeXRA/pull/12134)         | Keep the defect fix, review the proposed representation. The current diff reconstructs severity by parsing formatted log text. Prefer carrying structured severity to the host's logging output and formatting at the destination, using supported logging facilities rather than introducing another text protocol.                                                                                                                               |

[Maintenance PR #12140](https://github.com/LionSR/TeXRA/pull/12140) separately
targets `release/0.40` with the three fixes in section 1. Local full type checks,
lint, extension build, and tests passed: 821 suites and 10,023 tests passed,
with one suite and six tests skipped. Package publication is a separate step;
the PR does not bump the version or publish a release.
