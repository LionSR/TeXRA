---
name: lean-proof-assistant
description: Develop and debug Lean 4 proofs in project context. Use when Codex needs to understand a theorem, inspect goals, search for supporting lemmas, write or repair Lean proof terms or tactic scripts, and iterate with diagnostics until the file is clean.
---

# Lean Proof Assistant

## When to use this skill

Use this skill for day-to-day Lean 4 proof development: proving lemmas, debugging errors, filling gaps, inspecting goals, or turning an informal proof outline into working Lean code.

## Workflow

1. Read the target file and surrounding declarations before editing. Understand the theorem statement, available hypotheses, and local notation. Also read the project's canonical tactic ledger in `AGENTS.md` if one exists. Prefer the project's custom tactics, simp sets, and workhorse lemmas over rebuilding inline tactic chains.
2. Check the current diagnostics first. Let the elaborator tell you what is actually wrong before you guess.
3. Outline the proof strategy informally before writing code when the theorem is nontrivial.
4. Search for existing lemmas and APIs before inventing helper lemmas or long tactic scripts.
5. Work in small iterations: edit one proof step, recheck, inspect the new goal state, and continue.
6. Prefer clear proof structure over brittle wizardry. Use the tactic or term style that makes the mathematical idea easiest to review.
7. Finish by making the file clean: no broken goals, no stale debugging commands, no accidental scaffolding left behind.

## Quality Bar

- Do not fight the goal blindly. Inspect the precise goal and local context after each meaningful step.
- Prefer existing Mathlib lemmas over reproving folklore.
- Keep proofs readable enough that another formalizer can maintain them.
- Treat diagnostics as ground truth.
- If a proof attempt becomes opaque or fragile, back up and choose a clearer route.

When the same tactic sequence or goal shape shows up for the third time, stop inlining it and use lean-tactic-improver when available. Otherwise use this standalone fallback: on the third occurrence, extract the lowest sufficient project-native abstraction without adding a framework solely for automation; rewrite the motivating call sites; add a `Name | Kind | Use when | Defined in` row to the canonical `AGENTS.md` tactic ledger, creating it if needed; if `CLAUDE.md` exists, preserve its contents and add a pointer to the `AGENTS.md` ledger unless both paths already identify the same file; and prune rows whose automation is removed.

For stuck proofs or longer debugging sessions, use [references/proof-workflow.md](references/proof-workflow.md) for a stricter loop around search, inspection, iteration, and cleanup.
