---
name: tikz-figure-builder
description: Create or refine TikZ figures for technical papers and slides. Use when Codex needs to add a new diagram, improve an existing figure, align a visual with manuscript notation, or iteratively compile and visually read the rendered output until the figure is correct and readable.
---

# TikZ Figure Builder

## When to use this skill

Use this skill for architecture diagrams, workflows, commutative diagrams, tensor-network sketches, algorithm schematics, annotated plots, and figure cleanups where the final output should be TikZ or closely integrated with LaTeX.

## Workflow

1. Read the surrounding manuscript or slide context before drawing. Match the figure to the notation, vocabulary, and mathematical meaning already in use.
2. Decide what the figure must communicate. Reduce the diagram to the essential objects, relationships, flow, or geometry.
3. Prefer reusable styles and compact structure over copy-pasted node formatting.
4. Compile every substantial TikZ change and visually read the rendered image or PDF, not just the source code. Treat this as an automatic loop: edit, build, read, fix, and rebuild until the figure is stable.
5. Fix clipping, crowding, label collisions, uneven spacing, unreadable labels, and style drift immediately instead of deferring them.
6. For mathematically meaningful diagrams, verify that topology, arrow direction, labels, and adjacency actually match the equations or constructions they represent.
7. Keep captions and in-text references synchronized with the final figure.

## Quality Bar

- A pretty but mathematically wrong diagram is a failure.
- Labels must be legible and consistent with manuscript notation.
- Spacing should make structure obvious without decorative clutter.
- Avoid duplicated style definitions across multiple figures when a shared style can live in the preamble or a common file.
- Do not stop at source edits alone when a build is possible; the default is to compile, visually read the rendered result, and refine until it is clean.
- Ensure the figure integrates cleanly into the surrounding text and layout.

For dense or math-sensitive figures, use [references/figure-checklist.md](references/figure-checklist.md) to run a stricter pass over layout, consistency, and rendered correctness.
