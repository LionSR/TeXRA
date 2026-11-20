# One-owner remainders the 2026-11-19 structural audit verified and deferred

Date: 2026-11-19
Status: implemented (sections 1 and 2 landed on 2026-11-19; section 3 was
ruled not to be done)
Origin: a scheduled whole-codebase structural-debt audit (12 seam maps, 4
ideation passes, 7 adversarial verifications) on `main` at `ceebb96`. Most
seams mapped HEALTHY: the run loop, the session-view reducer, the llm
provider codecs, the UI copy tables and the agent-CLI backends are deep,
single-owner modules after the recent consolidations. The decision-free
data-shape and layer themes were already in flight the same morning
(#15053, #15054, #15056, #15058, #15059), so this note records only what
survived verification and was not taken there.

The one survivor that stands alone landed with this note: a plain
user-question skip now carries no feedback, so the tool's own "The user
declined to answer" is the one wording for the fact, the same text the
webview's skip already produces (`USER_QUESTION_SKIPPED_FEEDBACK` is gone).
The findings below are real but need more than an autonomous pass, each for
the reason given, in the order worth taking.

## 1. The app-state write validates JSON twice, but one owner needs an error route

_Landed the same day. The pre-check is gone; `currentValues.modify` encodes
each next value once (`encodeValue`), and a value its family's schema
refuses fails the write as a `StoreCheckFailed` naming the family and key,
which reaches the settings store's caller inside the `StateWriteFailed` it
already raised for a `DatabaseWriteFailed`. The type question below was
answered at the families: `APP_STATE` and `REPO_STATE` are
`ValueFamily<unknown>` (a settings store hands on what its caller gave it;
the schema, `Schema.Json`, is what the write checks), so no cast was needed.
The rest of this section is the finding as written._

`appStateStoreFromDatabase`
(`packages/harness/src/controllers/session/appStateStore.ts:51-63`) runs
`Schema.decodeUnknownResult(Schema.Json)` over every value before handing it
to `values.modify`, and `currentValues.modify`
(`packages/harness/src/controllers/session/currentValues.ts:173-175`) then
encodes the same value with `Schema.encodeEffect(Schema.fromJsonString(family.schema))`,
where `family.schema` is `Schema.Json` for both `APP_STATE` and `REPO_STATE`
(`valueFamily.ts`). So a current-value write proves the value is JSON twice.
`WORKSPACE_STORES` already skips the `appStateStore` pre-check and is written
straight through `currentValues.modify` (`appStateStore.ts:149`), which is
the intended single boundary.

Correcting the finding on inspection: dropping the pre-check is **not** a
clean deletion, which is why it is deferred rather than landed.

- **Error quality.** The pre-check maps a non-JSON value to a typed
  `StateWriteFailed` with the message `State key <k> was given a value that
  is not JSON`. `currentValues.modify`'s encode fails with a raw Schema
  `ParseError`, which `appStateStore`'s `mapError` only rewraps for
  `DatabaseWriteFailed` (`appStateStore.ts:103-107`), so the typed settings
  error and its message would be lost — a silent degradation of the write
  path's error surface.
- **Types.** `appStateStore.modify`'s `change` returns `Record<K, unknown>`;
  `currentValues.modify` expects the next values typed as the family's
  decoded type (`Json` here). Removing the pre-check leaves `unknown` flowing
  into a `Json` slot, which needs a cast the core bans, unless the callers
  are retyped.

The real fix is to make `currentValues.modify` the one owner **and** route
its encode failure into `StateWriteFailed` (a typed encode error the store
rewraps beside `DatabaseWriteFailed`), so the one validation keeps the one
error. That is a small design step on the persisted-state boundary, not a
mechanical drop; it belongs with whoever next edits `currentValues`.

## 2. The LaTeX tool roster is restated as seven `*Path` fields

Landed 2026-11-19. `LatexSettingsStatusSchema`
(`packages/texra/src/shared/settingsView/settingsViewMessages.ts`) carries
`paths`, one record keyed by `PROBED_LATEX_TOOLS`, built once from the probe
result by `probedToolPaths`; the seven fields, their seven defaults and the
seven `pathOf('<tool>')` assignments are gone. The display policy the fields
encoded (pdflatex and latexmk on the compiler card, no path for perl, `gm`
or else `magick` as the image card's second line) moved into the tab as
`DEPENDENCIES.pathLines` (`packages/texra/src/ui/settings/tabs/LaTeXTab.ts`),
unchanged: screenshots of the desktop app's LaTeX tab before and after, with
every tool present and with latexmk, latexindent and gm absent, are
byte-identical. Whether those three rules should change is still item 3 of
`2026-11-15-data-shapes-left-after-the-audit.md`.

## 3. The model media-acceptance rule, split in two (decision-gated, a wash)

`partsForFile` and `storedMediaPart`
(`packages/harness/src/agent/runtime/run/mediaInput.ts`) each branch the same
pdf/image/audio capability rule in different return shapes, and the
PDF→pages fallback is split between `partsForFile` (inline) and
`FollowUps.batchMessage` (re-derived from `storedMediaPart` returning null).
A shared `mediumKind(mimeType, capabilities)` predicate would give the
classification one owner. Verification scored this a wash (≈ 0 element
delta: the two functions legitimately return different payloads, so only the
predicate is shared) and the caller contract would change, so it is recorded,
not proposed, pending an owner's call on whether the shared predicate earns
its export.

Ruled 2026-11-19: not to be done
(`MEDIA-one-capability-classifier` in `.agents/docs/refuted-candidates.json`).
