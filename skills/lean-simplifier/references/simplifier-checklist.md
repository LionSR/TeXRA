# Lean Simplifier Checklist

Use this checklist for deeper cleanup passes aimed at Mathlib-quality code.

## Style and organization

- Keep imports minimal and organized.
- Use consistent naming that follows Mathlib patterns.
- Add or improve docstrings for public declarations.
- Group related declarations and remove dead fragments.

## Proof cleanup

- Replace brittle chains with clearer arguments when possible.
- Prefer `calc`, well-scoped `simp`, and direct structure over clutter.
- Avoid shortening proofs at the cost of readability.
- Read the canonical tactic ledger in `AGENTS.md` and reuse existing automation before writing a new tactic chain.

## Generality and reuse

- Use the weakest useful assumptions.
- Merge true duplicates through generalization when it simplifies the API.
- Search Mathlib before retaining project-local copies of standard results.
- Extract tactic sequences repeated three or more times into project automation (see lean-tactic-improver) and record them in the canonical `AGENTS.md` tactic ledger; make `CLAUDE.md` share or point to it if present, and prune entries for automation you remove.

## Verification

- Re-run diagnostics after each logical edit.
- Revert any refactor that introduces new breakage or obscures the argument.
