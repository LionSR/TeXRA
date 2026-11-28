# Callback-type species and the caption block: what the 2026-11-28 scan left open

Date: 2026-11-28
Status: proposed

Origin: the scheduled audit for ad hoc or messy implementations. Two
read-only scans — the harness and llm; the app and the three hosts — each
cross-checked against `.agents/docs/refuted-candidates.json`, the
2026-11-24 duplication scan, the 2026-11-25 ad-hoc scan and the 2026-11-23
through 2026-11-27 daily notes.

Both scans reach the same verified negative the 2026-11-24 and 2026-11-25
scans already recorded: **there is no large (300–650 line) mechanical
consolidation left in any package.** Normalized-block hashing finds no
cross-file duplicate bodies; the max repetition of any inline object type
literal is three; the formatting, selection and grouping helpers are already
single-owned or on a builtin. The one species still spread past the 5-site
bar was the callback type written out at each implementer, which the PR that
adds this note swept to completion:

- `StateChange` (5 stores) and `SubscribeTranscripts` (4 subscribers) —
  item 4 of `2026-11-27-consolidation-and-natives-left-open.md`.
- `SubagentProgressNotify` (6 sites, agent delegation) and
  `SubscriptionDeviceCodeHandler` (4 `onPrompt` sites, llm `oauth/`) — the
  same species, not previously recorded.
- `captionDeclarations` — the `--font-size-xs` + `--color-text-secondary`
  caption pairing, interpolated into 16 rule bodies across 9 sheets, as
  `truncateDeclarations`/`overlineDeclarations` already are
  (`2026-11-27-ui-kit-bypasses-left-open.md` item 7).

After it, no callback type is spelled out at more than three implementers,
and the `*Declarations` precedent owns the caption block.

## Open (each small, none audit-sized on its own)

1. **The terminal `loadingLabel="Loading …"` string is repeated at six
   forms** (`SkillsSettingsForm.tsx`, `SkillsListForm.tsx`,
   `ResumeListForm.tsx`, `ModelListForm.tsx`, `EnabledModelsForm.tsx`,
   `CliConfigForm.tsx`). One copy constant. ~0 net lines; a copy-owner
   tidy, `2026-11-27-ui-kit-bypasses-left-open.md` item 13.
2. **The `--font-size-sm` + `--color-text-secondary` secondary pairing**
   (two desktop sheets and nine more) is a different size and was left
   alone; its own `captionSmDeclarations` block is the matching step, kept
   separate so no rule silently changes size.
3. **The llm `oauth/` coordinators still pass `Effect` only for the handler
   type** at the sites now typed by `SubscriptionDeviceCodeHandler`; the
   import stays because other members use it. No action.

## Needs a decision first (left to the owner)

- **"Report a failure, pass an interrupt" is written per host** (item 3 of
  `2026-11-27-consolidation-and-natives-left-open.md`): two owners answer an
  interrupt-only cause with `Effect.void` and two raise the interrupt again,
  so the one app owner needs that behaviour decided before the ~15 sites
  fold onto it.
