---
name: manuscript-review
description: Audit technical manuscripts for mathematical correctness, logical soundness, notation consistency, evidence quality, and figure or code alignment. Use when Codex needs to review a paper, verify derivations, prioritize findings, or produce a rigorous findings-first assessment instead of rewriting prose blindly.
---

# Manuscript Review

## When to use this skill

Use this skill for serious review passes on papers, notes, appendices, or technical drafts where the main job is to find problems, verify important claims, and report actionable findings.

## Workflow

1. Read the full manuscript context first, including appendices, bibliography, macros, figures, and any supporting code that drives results.
2. Identify the main claims and the highest-risk derivations, proofs, experiments, and references before going broad.
3. Verify critical calculations independently when feasible. Check limiting cases, dimensions, signs, factors, boundary conditions, and whether stated results follow from the setup.
4. Use computational verification tools when available for symbolic algebra, identities, spot checks, and code-backed results. If you verify something numerically or symbolically, say so explicitly in the findings.
5. Trace notation across the document. Confirm symbols are defined before use and stay stable across sections, figures, and code.
6. Check code-manuscript consistency when the paper depends on scripts, notebooks, generated figures, or implemented algorithms.
7. Check whether the manuscript actually delivers the goals stated in the abstract and introduction.
8. Produce findings first. Order them by severity and point to exact locations.
9. Distinguish confirmed errors, likely issues, and open questions. Do not blur them together.

## Quality Bar

- Check appendices before claiming a derivation is missing.
- Focus on issues that affect validity, interpretation, reproducibility, or reader comprehension.
- Be specific about what you verified and how.
- Prefer a short list of high-signal findings over a noisy dump of minor edits.
- If no major issues are found, say that explicitly and note any residual uncertainty or untested areas.

For a formal audit pass, use [references/review-checklist.md](references/review-checklist.md) when the manuscript is mathematically dense, has code-backed figures or computations, or needs a full findings report.
