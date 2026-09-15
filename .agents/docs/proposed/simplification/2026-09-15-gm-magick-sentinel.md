# gm/magick display sentinel decoded at render time

Date: 2026-09-15
Origin: 15-domain simplification sweep (webview frontend domain); bounded items
filed separately as #12566.

## Problem

The dependency-check wire field `missingTools: z.array(z.string()).nullish()`
(`src/shared/schemas/mainView/state.ts:247`) carries the display sentinel
`'gm/magick'`. `checkCoreDependencies` pushes the token
(`src/utils/system/toolUtils.ts:400`), and the renderer must unpack it at render
time: `DependencyBanner.ts:71-75` splits the token into `['gm','magick']`,
re-derives `imageToolMissing`, and maps tool ids to display labels
(`getToolLabel`, :14-23). This is render-time compensation for a data-model
wart: the wire carries a display encoding that the view must decode, and the
decode can drift from `IMAGE_TOOLS` in `src/shared/constants/latexToolchain.ts:35`
(`gm` and `magick` both have `TOOL_CONFIGS` doc entries, `toolUtils.ts:103-109`).

Verified consumer topology: the string list's only consumer is the banner path
(`ProgressViewProvider.ts:256-259`; the recheck call at
`extensionHostRequests.ts:838` discards the return).

## Proposal

Move the choose-one semantics upstream, where the fact is produced:

- `checkCoreDependencies` emits two independent entries, `gm` and `magick`,
  with the either-or relationship carried explicitly rather than encoded in a
  display string; or
- emit a structured `{ tool, label, alternatives }` shape if the banner needs
  to keep rendering "GraphicsMagick or ImageMagick" wording.

The banner then renders entries directly; the `flatMap` split, the
`imageToolMissing` re-derivation, and the `getToolLabel` id→name map move
upstream or disappear.

## What we give up

A wire-schema change (`mainView/state.ts`) and a touch of the
`VerifySetupTool` alias path, which reads the same token.

## Acceptance criteria

- `DependencyBanner` contains no string splitting on `'gm/magick'` and no
  `imageToolMissing` re-derivation.
- The missing-tool presentation is unchanged for users (both tools listed with
  choose-one wording when applicable).
- The `TOOL_CONFIGS` doc entries for `gm`/`magick` remain the label SSOT.

## Risks

Medium: touches a wire schema consumed by both hosts' progress surfaces and
the `VerifySetupTool` alias path. Contained: the missing-tools list has
exactly one consumer path.

## Estimated delta

≈ −8 LoC in the banner, +similar upstream (net ≈ 0); the win is removing a
decode that can silently drift from `IMAGE_TOOLS`, not LoC.
