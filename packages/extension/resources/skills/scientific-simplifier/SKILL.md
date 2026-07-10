---
name: scientific-simplifier
description: Simplify scientific code, LaTeX, and technical prose while preserving exact behavior, results, and meaning. Use when Codex needs to remove duplication, reduce unnecessary abstraction, clean up AI-generated bloat, or make a research codebase or manuscript clearer without changing its substance.
---

# Scientific Simplifier

## When to use this skill

Use this skill when a scientific project feels bloated, repetitive, over-abstracted, or harder to read than it should be, but the underlying behavior and mathematics must remain unchanged.

## Workflow

1. Inspect the target area before editing. Identify what is duplicated, indirect, dead, formulaic, or misleadingly complex.
2. Preserve outputs and meaning. Treat simplification as an expression change, not a behavior change.
3. Remove duplication only after verifying the repeated pieces serve the same purpose, not merely a similar shape.
4. Prefer direct, idiomatic language and native constructs over custom wrappers or ornamental abstractions.
5. Tighten scientific prose aggressively: delete filler openings, redundant transitions, vague significance claims, and conversation leakage.
6. Simplify one logical piece at a time and verify after each change with tests, compilation, or equivalent checks.
7. Stop when the code or prose reads like a deliberate design, not a pile of edits.

## Quality Bar

- Do not collapse distinct scientific regimes or assumptions into one helper just to save lines.
- Do not replace clear control flow with clever one-liners.
- Do not remove notation, equations, or comments that carry real meaning.
- Prefer smaller, safer edits over sweeping rewrites when the verification surface is large.
- If a simplification changes results, semantics, or narrative emphasis, revert it.

For a broader cleanup pass, use [references/simplification-checklist.md](references/simplification-checklist.md) when the codebase is large, the prose shows obvious AI artifacts, or you need a more systematic review of duplication and abstraction.
