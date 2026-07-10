---
name: scientific-presenter
description: Build or revise scientific talks, posters, and Beamer slide decks from papers, codebases, figures, or LaTeX templates. Use when Codex needs to turn technical research into a clear presentation, preserve an existing slide theme, generate or improve figures, or iteratively compile and visually check presentation output.
---

# Scientific Presenter

## When to use this skill

Use this skill for research talks, posters, code walkthrough decks, paper-to-slides conversions, and presentation revisions where visual quality matters as much as technical accuracy.

## Workflow

1. Read any provided `.tex`, `.sty`, poster template, or slide template before planning content. Preserve the existing theme, typography, colors, macros, and structure unless the user asks for a redesign.
2. Survey the workspace before editing. Identify the core claims, algorithms, figures, tables, equations, and code artifacts that actually belong in the presentation.
3. Plan the deck around a story rather than around the paper's section order. Make each slide answer one question or advance one idea.
4. Prefer visual communication. Turn architecture, pipelines, derivations, and comparisons into diagrams, tables, overlays, or compact equations instead of dense prose blocks.
5. Keep code excerpts short and purposeful. Show only the lines needed to explain the mechanism, result, or design decision.
6. Compile early and often. After each substantial change, inspect the rendered output and fix layout, overflow, readability, and figure quality issues before continuing.
7. If figures or plots are generated from code, rerun the code when feasible and verify the resulting assets instead of mocking them by description.

## Quality Bar

- Keep body text readable at presentation scale. Split crowded slides instead of shrinking everything.
- Use equations sparingly and only when they clarify the argument. Define notation before using it on slides.
- Keep aspect ratios intact for figures and ensure axes, legends, and units are visible.
- Use progressive disclosure when the audience must absorb a derivation, algorithm, or workflow in stages.
- Treat visual QA as mandatory. A slide that compiles but clips, overlaps, or hides labels is not done.

For a stricter final pass, use [references/slide-quality-checklist.md](references/slide-quality-checklist.md) to review slide density, figure quality, poster layout, and Beamer-specific issues.
