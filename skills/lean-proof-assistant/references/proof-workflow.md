# Lean Proof Workflow

Use this checklist when proof development is stuck or the file needs a disciplined debugging loop.

## Core loop

- Read the theorem statement and nearby lemmas first.
- Check diagnostics before guessing.
- Inspect the exact goal and local hypotheses after each meaningful step.
- Edit in small increments and recheck immediately.

## Search and proof strategy

- If the project has a canonical tactic ledger in `AGENTS.md`, check it for custom tactics, simp sets, and workhorse lemmas before writing long tactic chains.
- Search for existing lemmas before proving helpers.
- Try both type-shape and name-based searches.
- Prefer clear proof structure over long fragile tactic chains.
- Use the tactic family that matches the goal shape instead of forcing one hammer everywhere.

## Cleanup

- If a tactic sequence recurred three or more times, use lean-tactic-improver when available; otherwise follow the standalone extraction and ledger fallback in the parent skill instead of leaving copies inline.
- Remove stale debugging commands and temporary scaffolding.
- Keep the final proof readable enough for another contributor to maintain.
- Leave the file with clean diagnostics.
