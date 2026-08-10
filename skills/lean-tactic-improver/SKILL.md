---
name: lean-tactic-improver
description: Extract repeated Lean 4 proof patterns into reusable project automation and record them in the project's canonical AGENTS.md tactic ledger. Use when Codex notices the same tactic sequences or goal shapes recurring across proofs and should turn them into lemmas, simp sets, aesop rules, or custom tactics for future sessions to reuse.
---

# Lean Tactic Improver

## When to use this skill

Use this skill when proof scripts are growing linearly with the mathematics: the same tactic sequence keeps being pasted, the same goal shape keeps being discharged by hand, or a new proof is mostly boilerplate already written elsewhere in the project. This skill is the self-improvement loop that converts that repetition into project automation and remembers it across sessions.

## The mechanism

The canonical ledger location, sharing rules, row format, abstraction ladder, and standalone fallback live in [references/tactic-ledger.md](references/tactic-ledger.md). Treat that reference as the single source of truth instead of restating the protocol in consumer skills or prompts.

## Workflow

1. Read or initialize the tactic ledger exactly as specified by the canonical protocol.
2. Watch for repetition while proving. Apply the rule of three: the third time a tactic sequence or goal shape recurs, stop inlining it and extract.
3. Choose the cheapest sufficient rung on the abstraction ladder: helper lemma → `@[simp]` lemma or named simp set → aesop rule set → tactic macro → full custom tactic. Use a framework-specific rung only when the project already provides that dependency; otherwise stay on a lower rung unless adding the dependency is explicitly in scope. Do not write an `elab` tactic where a lemma would do.
4. Put domain-specific automation beside the declarations it depends on. Use an early-imported file such as `Project/Tactic.lean` or `Project/Attr.lean` only for dependency-light shared infrastructure. Add a docstring stating what goal shapes the automation closes.
5. Prove its worth immediately: rewrite the call sites that motivated the extraction. Every one of them must get shorter or clearer; if they do not, revert the abstraction.
6. Record it: add or update the ledger entry (name, kind, use-when, defining file) so the next session starts from the improved baseline.
7. Curate on every pass: prune ledger entries whose automation was removed, and merge overlapping automation instead of accumulating near-duplicates.

## Quality Bar

- Judge automation by its call sites: three or more real uses, each shorter and clearer than before.
- Automation must compress _and_ clarify. A macro that hides the mathematical argument is a regression even when it shortens the file.
- Keep the global `simp` set safe: prefer named simp sets or `simp only` lemma lists over broad `@[simp]` attributes that slow builds or break distant proofs.
- Never change what theorems state; extraction refactors proofs, not statements.
- Keep the ledger short and current. A stale or bloated ledger is ignored, and an ignored ledger ends the improvement loop.

For the ledger format, the full abstraction ladder with Lean idioms, and the extraction checklist, use [references/tactic-ledger.md](references/tactic-ledger.md).
