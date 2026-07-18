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
- If the project has a canonical tactic ledger in `AGENTS.md`, read it and reuse existing automation before writing a new tactic chain.

## Generality and reuse

- Use the weakest useful assumptions.
- Merge true duplicates through generalization when it simplifies the API.
- Search Mathlib before retaining project-local copies of standard results.
- For tactic sequences repeated three or more times, use lean-tactic-improver when available; otherwise follow the standalone extraction and ledger fallback in the parent skill. Prune entries for automation you remove.

## Verification

- Re-run diagnostics after each logical edit.
- Revert any refactor that introduces new breakage or obscures the argument.
