# OCR Checklist

Use this file when the handwriting or scan quality makes transcription error-prone.

## Context matching

- Reuse the target document's notation, macros, and environment style.
- Resolve ambiguous symbols against nearby equations or definitions first.

## Common OCR traps

- Similar letters such as `x` and `\chi`, `v` and `\nu`, `l` and `1`
- Misread superscripts, subscripts, and nested braces
- Dropped delimiters, alignment markers, or fraction structure
- Swapped indices or incorrect ordering in tensor-like notation

## Final checks

- Ensure the LaTeX is syntactically valid.
- Preserve the intended structure of multi-line derivations.
- Flag unresolved ambiguity instead of inventing precision that is not supported by the image.
