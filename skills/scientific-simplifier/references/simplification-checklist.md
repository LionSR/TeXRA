# Simplification Checklist

Use this checklist for a deeper pass when a codebase or manuscript has accumulated obvious complexity.

## Code structure

- Find wrappers, dispatch layers, and factories that add no real abstraction.
- Remove dead code, unreachable branches, and commented-out blocks.
- Consolidate true duplicates only after checking semantics.
- Replace hand-rolled utilities with clear native constructs when that improves readability.

## Scientific prose

- Delete filler openings, repetitive transitions, and empty significance claims.
- Remove conversation leakage such as change notes or assistant-style narration.
- Replace vague claims with specific statements or cut them.
- Introduce notation once and stop re-explaining it.

## Safety checks

- Run tests, compile, or otherwise verify after each logical change.
- Revert any simplification that changes behavior, results, or scientific meaning.
- Prefer the smallest edit that materially improves clarity.
