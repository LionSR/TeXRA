# Index: one authoritative note per topic

Read the owner first. Everything else on a topic is background. When the design changes, change
the owning note rather than adding a parallel one. Questions already settled
live in the
[architecture rulings ledger](./implemented/architecture/2026-08-01-architecture-rulings-ledger.md)
and are not re-litigated; a proposal that contradicts a ruling cites the
ruling and argues against it explicitly.

| Topic                                     | Authoritative note                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Settled questions, all topics             | [architecture rulings ledger](./implemented/architecture/2026-08-01-architecture-rulings-ledger.md)                   |
| Core concepts, owners and Effect layering | [core concepts](./implemented/architecture/2026-09-26-core-concepts.md)                                               |
| Harness 1.0 release requirements          | [Harness 1.0 发布 PRD](./proposed/architecture/2026-10-28-harness-1-release-prd.md)                                   |
| The harness as a general package          | [harness general-package design](./proposed/architecture/2026-10-21-harness-general-package-design.md)                |
| The harness / app / llm package split     | [harness package split](./implemented/architecture/2026-10-02-harness-package-split.md)                               |
| Durable runs: replay, fork, compaction    | [durable harness](./implemented/architecture/2026-10-02-durable-harness.md)                                           |
| Storage format and the session database   | [storage v1 design](./implemented/architecture/2026-09-28-storage-v1-design.md)                                       |
| Plugins and their contributions           | [plugin architecture](./implemented/architecture/2026-09-24-plugin-architecture.md)                                   |
| Code plugins and hooks                    | [code plugins and hooks](./implemented/architecture/2026-09-28-code-plugins-hooks-v1.md)                              |
| Code as tool (`script`, `agent()`)        | [codemode everywhere](./implemented/architecture/2026-10-01-codemode-everywhere.md)                                   |
| The run model: one run, one run history   | [one run model](./implemented/architecture/2026-09-10-one-run-model.md)                                               |
| Run state the hosts render                | [one fold, three renderers](./implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md)                    |
| Non-run current-value state               | [current-value SQLite rows](./implemented/architecture/2026-09-22-current-value-state-decision.md)                    |
| Errors, failure ownership, event channels | [error pipeline and ownership](./implemented/architecture/2026-06-10-error-pipeline-and-ownership.md)                 |
| Liveness and single ownership of a run    | [single owner liveness and one fold](./implemented/architecture/2026-09-20-single-owner-liveness-and-one-fold.md)     |
| Run-to-run messaging, subagent reports    | [session messaging](./implemented/architecture/2026-09-25-session-messaging.md)                                       |
| Child-run concurrency                     | [child run concurrency budget](./implemented/architecture/2026-08-15-child-run-concurrency-budget.md)                 |
| GitHub Copilot (removed; options parked)  | [Copilot possibilities](./proposed/feature/2026-10-26-copilot-possibilities.md)                                       |
| `packages/llm`                            | [`packages/llm/README.md`](../../packages/llm/README.md)                                                              |
| Observability and the trace plane         | [observability plane](./implemented/architecture/2026-09-09-observability-plane.md)                                   |
| Dual systems and Promise/Effect seams     | [effect round trips and dual systems](./implemented/simplification/2026-09-17-effect-round-trips-and-dual-systems.md) |
| Which Effect facility replaces what       | [effect facility adoption](./implemented/simplification/2026-09-20-effect-facility-adoption.md)                       |
| Test estate, tiers and the registry       | [shared module registry](./proposed/testing/2026-09-10-shared-module-registry.md)                                     |
| GUI nouns, one home per action, cuts      | [GUI code as tool](./implemented/feature/2026-10-02-gui-code-as-tool.md)                                              |
| Desktop and extension UX: open work       | [UX principles and work order](./proposed/feature/2026-09-26-desktop-and-extension-ux-roadmap.md)                     |
| What the repo owes an autonomous agent    | [agent-refactorability gates](./implemented/process/2026-09-20-agent-refactorability-gates.md)                        |
| Runtime performance budgets               | [runtime performance measurement record](./proposed/process/2026-09-21-runtime-performance-measurement-record.md)     |

A topic missing from this table has no owner yet: the tree and `git log` are
the index for everything else, as they always were. Adding a row is how a note
claims ownership, so add one in the same PR that makes a note authoritative,
and move the row when the owner moves.
