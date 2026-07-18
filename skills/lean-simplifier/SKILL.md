---
name: lean-simplifier
description: Refactor Lean 4 code and proofs toward Mathlib-quality style without changing theorem statements or computational meaning. Use when Codex needs to simplify tactic scripts, generalize declarations, improve naming and organization, remove duplication, or make Lean code cleaner and more upstream-ready.
---

# Lean Simplifier

## When to use this skill

Use this skill when Lean code already works or nearly works, but it is noisy, repetitive, overly specialized, poorly named, or farther from Mathlib style than it should be.

## Workflow

1. Read the file as a whole before changing local proofs. Many style and generality problems only make sense at file scope.
2. Check diagnostics first so you know whether you are simplifying a clean file or repairing active breakage.
3. Preserve meaning exactly: theorem statements, definitions, and computed behavior should not change.
4. Improve the file in the order that usually pays off most: naming and organization, import hygiene, docstrings, proof cleanup, then generalization and deduplication.
5. Replace brittle tactic chains with clearer arguments when that actually improves reviewability.
6. Search Mathlib before keeping local lemmas that smell standard.
7. When deduplication reveals a tactic sequence or goal shape repeated three or more times, extract it into project automation (lemma, simp set, aesop rules, or tactic macro) via the lean-tactic-improver skill and record it in the tactic ledger in `AGENTS.md`/`CLAUDE.md`.
8. Recheck after each logical edit and revert any “simplification” that makes the code harder to trust.

## Quality Bar

- Target Mathlib-quality readability, not just shorter code.
- Prefer the weakest useful assumptions and the most general reusable statement.
- Do not over-generalize just for aesthetics.
- Remove debugging leftovers, dead code, and sorry-driven scaffolding.
- A shorter proof is worse if it becomes opaque.

For serious cleanup or upstream preparation, use [references/simplifier-checklist.md](references/simplifier-checklist.md) to review style, generality, proof cleanup, and lint-facing details.
