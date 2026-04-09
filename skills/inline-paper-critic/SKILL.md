---
name: inline-paper-critic
description: Critically annotate technical papers with inline comments about mathematical gaps, unjustified steps, risky assumptions, and verified results. Use when Codex needs to leave compile-safe review comments directly in a LaTeX manuscript, especially in a `\\criticize{comment}{severity}{confidence}` style for derivation-heavy papers where appendices and hidden calculations must be checked carefully.
---

# Inline Paper Critic

## When to use this skill

Use this skill for inline technical review of mathematical or derivation-heavy papers when the output should be comments embedded in the manuscript rather than a separate review memo.

## Workflow

1. Read the entire manuscript, including appendices and auxiliary files, before deciding that a step is missing or unjustified.
2. Expand important derivations mentally or on scratch paper before commenting. A good inline critique should come from actual verification, not surface-level suspicion.
3. Prioritize issues that affect validity: broken proofs, missing essential steps, unjustified coefficients, hidden assumptions, incorrect limits, or inconsistent claims.
4. If a derivation is already handled in an appendix, say so and adjust severity accordingly rather than treating the main text as simply wrong.
5. When the document already uses a `\criticize{comment}{severity}{confidence}`-style macro, preserve that format. Otherwise adapt to the local inline annotation convention without losing the same discipline.
6. If the macro is missing, provide a minimal command definition before inserting annotations:

   ```latex
   \newcommand{\criticize}[3]{\textcolor{red}{\textbf{[#2|#3]} #1}}
   ```

   Keep the document's existing color/theme conventions when present.

7. Use inline comments strategically. Group related minor issues and reserve the harshest comments for problems that really threaten the result.
8. When a calculation checks out, leave explicit verification comments when that helps the author distinguish true problems from confirmed material.
9. Ensure every inline comment is valid LaTeX and can remain in the document without breaking compilation.

## Quality Bar

- Check appendices before accusing the paper of omission.
- Base comments on actual mathematical verification whenever possible.
- Use severity and confidence consistently; do not inflate comments just to sound forceful.
- Treat severity as impact on validity and confidence as certainty of the diagnosis, not as two versions of the same number.
- A compile-safe inline review comment is better than a sharper comment that breaks the document.
- If you verified something as correct, say what you checked.

For a deeper pass over severity discipline, appendix-first review, and compile-safe comment writing, use [references/critique-checklist.md](references/critique-checklist.md).
