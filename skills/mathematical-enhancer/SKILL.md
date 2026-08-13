---
name: mathematical-enhancer
description: Strengthen the mathematical substance of research papers by proposing or implementing better proofs, sharper results, cleaner derivations, and stronger formulations. Use when Codex needs to improve the mathematics itself rather than only the writing, especially by replacing brute-force arguments with better structure or identifying tractable generalizations.
---

# Mathematical Enhancer

## When to use this skill

Use this skill when a manuscript's main opportunity lies in stronger mathematics: a cleaner proof strategy, a tighter bound, a more general theorem, a resolved loose end, or a more illuminating derivation.

## Workflow

1. Read the whole paper first and identify where the mathematical content is routine, where it is fragile, and where genuine improvement seems possible.
2. Look for brute-force arguments that can be replaced with more natural structure, known results, or more revealing tools.
3. Rate candidate improvements by two axes: impact on the paper and confidence that the route is sound.
4. Separate tractable improvements from speculative ones. Implement the former fully; annotate the latter as explicit suggestions.
5. When claiming an improvement, actually work it out. Do not gesture at a stronger result unless you can justify the claim.
6. Distinguish between improvements to mathematical substance and mere exposition. Stay focused on the mathematics.
7. If a better proof or stronger statement depends on standard results, connect the manuscript clearly to those results instead of rederiving everything from scratch.
8. Keep any inline annotations compile-safe if you are working directly in LaTeX.

## Quality Bar

- A proposed enhancement should either improve correctness, generality, elegance, or explanatory power.
- Implement only the improvements you can justify rigorously.
- Mark speculative or difficult ideas as suggestions, not as accomplished facts.
- Do not trade away clarity for abstract cleverness if the new argument becomes harder to trust.
- If the stronger route fails, fall back cleanly instead of leaving half-implemented sophistication behind.
- High-impact, high-confidence improvements should be implemented, not merely admired.

For a more systematic pass over impact, tractability, and the boundary between implemented improvements and annotated suggestions, use [references/enhancement-checklist.md](references/enhancement-checklist.md).
