# Figure Checklist

Use this file when a TikZ figure needs a stricter validation pass.

## Technical correctness

- Check that node relationships, arrows, labels, and topology match the underlying math or algorithm.
- Confirm the figure uses the same notation as the surrounding document.

## Layout

- Check for clipped edges, overlapping labels, uneven spacing, and hard-to-follow routing.
- Make the visual hierarchy obvious without decorative clutter.

## Reuse and consistency

- Factor repeated styles into shared definitions when multiple figures use the same look.
- Keep captions and in-text references aligned with the final figure.

## Compile-and-inspect loop

- Recompile after meaningful edits.
- Visually read the rendered figure, not just the source.
- Fix layout defects immediately instead of stacking more edits on top.
- Repeat the loop until clipping, collisions, spacing defects, and notation mismatches are gone rather than stopping after the first successful build.
