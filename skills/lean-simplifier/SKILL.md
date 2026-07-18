---
name: lean-simplifier
description: Refactor Lean 4 code and proofs toward Mathlib-quality style without changing theorem statements or computational meaning. Use when Codex needs to simplify tactic scripts, generalize declarations, improve naming and organization, remove duplication, or make Lean code cleaner and more upstream-ready.
---

# Lean Simplifier

## When to use this skill

Use this skill when Lean code already works or nearly works, but it is noisy, repetitive, overly specialized, poorly named, or farther from Mathlib style than it should be.

## Workflow

1. Read the file as a whole before changing local proofs. Many style and generality problems only make sense at file scope.
2. If the project has a canonical tactic ledger in `AGENTS.md`, read it and prefer its existing automation over new inline tactic chains.
3. Check diagnostics first so you know whether you are simplifying a clean file or repairing active breakage.
4. Preserve meaning exactly: theorem statements, definitions, and computed behavior should not change.
5. Improve the file in the order that usually pays off most: naming and organization, import hygiene, docstrings, proof cleanup, then generalization and deduplication.
6. Replace brittle tactic chains with clearer arguments when that actually improves reviewability.
7. Search Mathlib before keeping local lemmas that smell standard.
8. When deduplication reveals a tactic sequence or goal shape repeated three or more times, use lean-tactic-improver when available. Otherwise use this standalone fallback: on the third occurrence, extract the lowest sufficient project-native abstraction without adding a framework solely for automation; rewrite the motivating call sites; add a `Name | Kind | Use when | Defined in` row to the canonical `AGENTS.md` tactic ledger, creating it if needed; if `CLAUDE.md` exists, preserve its contents and add a pointer to the `AGENTS.md` ledger unless both paths already identify the same file; and prune rows whose automation is removed.
9. Recheck after each logical edit and revert any “simplification” that makes the code harder to trust.

## Quality Bar

- Target Mathlib-quality readability, not just shorter code.
- Prefer the weakest useful assumptions and the most general reusable statement.
- Do not over-generalize just for aesthetics.
- Remove debugging leftovers, dead code, and sorry-driven scaffolding.
- A shorter proof is worse if it becomes opaque.

For serious cleanup or upstream preparation, use [references/simplifier-checklist.md](references/simplifier-checklist.md) to review style, generality, proof cleanup, and lint-facing details.
