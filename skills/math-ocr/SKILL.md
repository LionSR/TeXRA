---
name: math-ocr
description: Convert handwritten or image-based mathematical content into notation-consistent LaTeX. Use when Codex needs to transcribe equations from notes, screenshots, whiteboards, or scans, reconcile ambiguous symbols against an existing document, or clean up OCR output into compilable mathematical LaTeX.
---

# Math OCR

## When to use this skill

Use this skill when the input is handwritten math, a screenshot of equations, or rough symbolic content that must become clean LaTeX matching an existing paper, note set, or slide deck.

## Workflow

1. Read the surrounding LaTeX context first when it exists. Reuse the document's notation, macro names, environment style, and equation conventions.
2. Inspect the image carefully before transcribing. Identify ambiguous glyphs, line breaks, superscripts, subscripts, delimiters, and alignment structure.
3. Translate math into the simplest correct LaTeX that matches the target document's style.
4. Mark uncertainty mentally and resolve it against context instead of guessing in isolation.
5. If the expression belongs inside a larger derivation, preserve the intended structure rather than producing a flat symbol dump.
6. Review the transcription once for likely OCR confusions such as similar letters, missing braces, swapped indices, or incorrect nesting.

## Quality Bar

- Notation consistency beats literal shape matching when the handwriting is ambiguous.
- Preserve mathematical structure, not just token order.
- Ensure delimiters, fractions, and indices are syntactically sound and compile cleanly.
- Prefer standard LaTeX environments already used by the target document.
- Call out unresolved ambiguity instead of silently inventing a precise symbol.

For ambiguity-heavy input, use [references/ocr-checklist.md](references/ocr-checklist.md) when the handwriting is messy, symbols are overloaded, or the result must fit strict manuscript notation.
