# Critique Checklist

Use this checklist for inline technical criticism of a manuscript.

## Verification before criticism

- Check appendices and supplementary derivations before claiming something is missing.
- Work through the calculation or proof enough to know whether the issue is real.
- Distinguish a missing explanation from an actual mathematical error.

## What to comment on

- Broken proofs or unjustified logical steps
- Missing derivation steps that matter for validity
- Unjustified coefficients, assumptions, or approximations
- Contradictions between text, equations, and claimed results
- Verified calculations that are worth marking as checked

## Severity and confidence

- Reserve the highest severity for issues that endanger the main claim.
- Use lower severity for exposition or local cleanup.
- Keep confidence separate from severity; an alarming but uncertain issue should say so.
- If using a `\criticize{...}{severity}{confidence}` scheme, keep the comment text self-contained and specific enough to survive outside the conversation.

## Typical scale

- Severity 5: invalidates a central claim or proof
- Severity 4: seriously weakens a major argument
- Severity 3: important but not fatal gap or inconsistency
- Severity 2: local but worthwhile fix
- Severity 1: cosmetic or low-impact cleanup

## LaTeX safety

- Write inline comments that compile cleanly.
- Use proper math mode, escaped special characters, and reference syntax.
- If `\criticize` is undefined, add a minimal macro such as
  `\newcommand{\criticize}[3]{\textcolor{red}{\textbf{[#2|#3]} #1}}` and match local style conventions.
- Prefer fewer precise comments over many noisy ones.
