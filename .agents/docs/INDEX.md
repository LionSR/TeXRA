# Index: one authoritative note per topic

Read the owner first. Everything else on a topic is background, and a note in
`archived/` is history, never current design. When the design changes, change
the owning note rather than adding a parallel one. Questions already settled
live in the
[architecture rulings ledger](./implemented/architecture/2026-08-01-architecture-rulings-ledger.md)
and are not re-litigated; a proposal that contradicts a ruling cites the
ruling and argues against it explicitly.

| Topic                                     | Authoritative note                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settled questions, all topics             | [architecture rulings ledger](./implemented/architecture/2026-08-01-architecture-rulings-ledger.md)                                                                                                               |
| Effect runtime: work order and gates      | [effect runtime delivery plan](./proposed/architecture/2026-09-06-effect-runtime-delivery-plan.md)                                                                                                                |
| Finishing the Effect-native cutover       | [effect-native completion protocol](./proposed/architecture/2026-09-15-effect-native-completion-protocol.md); [refreshed audits (2026-09-21)](./proposed/architecture/2026-09-21-ownership-audits-12424-12425.md) |
| Plugins, compositions and contributions   | [plugin architecture](./implemented/architecture/2026-09-24-plugin-architecture.md)                                                                                                                               |
| The run model: one run, one ledger        | [one run model](./implemented/architecture/2026-09-10-one-run-model.md)                                                                                                                                           |
| Run programs: tool-use vs. reflection     | [one run program](./proposed/architecture/2026-09-24-one-run-program.md)                                                                                                                                          |
| Run state the hosts render                | [one view state, three renderers](./implemented/architecture/2026-09-03-one-view-state-three-renderers.md)                                                                                                        |
| Non-run current-value state               | [current-value SQLite rows](./proposed/architecture/2026-09-22-current-value-state-decision.md)                                                                                                                   |
| Errors, failure ownership, event channels | [error pipeline and ownership](./implemented/architecture/2026-06-10-error-pipeline-and-ownership.md)                                                                                                             |
| Liveness and single ownership of a run    | [single owner liveness and one fold](./implemented/architecture/2026-09-20-single-owner-liveness-and-one-fold.md)                                                                                                 |
| The `@texra-ai/agent` public surface      | [agent SDK tier-1 manifest](./proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)                                                                                                                      |
| Standing SDK-readiness re-verification    | [2026-09-24 re-verification](./proposed/architecture/2026-09-24-agent-sdk-readiness-reverify.md)                                                                                                                  |
| `packages/llm`                            | [LLM package hardening](./proposed/architecture/2026-09-20-llm-package-hardening.md)                                                                                                                              |
| Observability and the trace plane         | [observability plane](./proposed/architecture/2026-09-09-observability-plane.md)                                                                                                                                  |
| Dual systems and Promise/Effect seams     | [effect round trips and dual systems](./proposed/simplification/2026-09-17-effect-round-trips-and-dual-systems.md)                                                                                                |
| Which Effect facility replaces what       | [effect facility adoption](./proposed/simplification/2026-09-20-effect-facility-adoption.md)                                                                                                                      |
| Test estate, tiers and the registry       | [shared module registry](./proposed/testing/2026-09-10-shared-module-registry.md)                                                                                                                                 |
| What the repo owes an autonomous agent    | [agent-refactorability gates](./proposed/process/2026-09-20-agent-refactorability-gates.md)                                                                                                                       |
| State of the tree after the refactors     | [post-refactor architecture survey](./proposed/architecture/2026-09-20-post-refactor-architecture-survey.md)                                                                                                      |
| Shipping 1.0                              | [TeXRA 1.0 implementation plan](./proposed/architecture/2026-09-09-texra-1-0-implementation-plan.md)                                                                                                              |
| Runtime performance budgets               | [runtime performance measurement record](./proposed/process/2026-09-21-runtime-performance-measurement-record.md)                                                                                                 |

A topic missing from this table has no owner yet: the tree and `git log` are
the index for everything else, as they always were. Adding a row is how a note
claims ownership, so add one in the same PR that makes a note authoritative,
and move the row when the owner moves.
