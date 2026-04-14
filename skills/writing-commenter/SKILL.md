---
name: writing-commenter
description: Review research writing by leaving inline comments on logic, notation, narrative flow, positioning, and editorial impact. Use when Codex needs to annotate a paper or draft with reader-facing comments instead of silently rewriting it, especially for argument structure, symbol consistency, and publication-oriented presentation.
---

# Writing Commenter

## When to use this skill

Use this skill when the main job is to comment on a manuscript rather than to silently edit it. It is suited to three distinct review modes: logical-flow review, notation review, and editorial elevation where the author should see the reasoning behind suggested changes.

## Workflow

1. Read the full manuscript before commenting. Understand the paper's argument, notation, structure, and current maturity level.
2. Choose the review mode up front unless the user explicitly asks for a mixed pass:
   - logical flow: structure, transitions, narrative coherence, balance of explanation
   - notation: symbol consistency, definition order, convention conflicts, graceful renaming
   - editorial elevation: title, abstract, framing, audience fit, rhetorical rhythm, figure-caption storytelling
3. Keep strict scope within the chosen mode. Do not drift into mathematical correctness, generic line edits, or copyediting unless the user asked for that.
4. Prefer inline comments that point to concrete issues and propose actionable fixes. If the document already has an annotation convention, preserve it.
5. In logic mode, comment where the reader loses the thread: weak transitions, misplaced paragraphs, unsupported jumps, and broken narrative arc.
6. In notation mode, comment where symbols are inconsistent, reused confusingly, or introduced too late, and prefer graceful solutions that minimize document-wide churn.
7. In editorial mode, comment where the paper undersells its contribution, flattens important ideas, fails to position itself for likely reviewers, or misuses figures, tables, and captions as mere decoration.
8. Keep the comments self-contained and compile-safe when they live inside LaTeX. The document should remain readable and buildable with the comments present.

## Quality Bar

- Comments should be specific enough that an author can act on them immediately.
- Prefer fewer, higher-signal comments over annotating every sentence.
- Distinguish local fixes from systemic issues. Do not pretend a document-wide reorganization is a one-line tweak.
- Preserve the author's voice and technical content; the goal is to diagnose and guide, not to overwrite reflexively.
- If the document already uses an inline comment macro, match its style and syntax correctly.
- For a mixed-mode review, still label the issue mentally by mode so the feedback does not blur into generic “make it better” commentary.

For a stricter pass over comment discipline, issue selection, and compile-safe inline annotations, use [references/commenting-checklist.md](references/commenting-checklist.md).
