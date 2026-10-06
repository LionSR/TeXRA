# TeXRA refactoring / tech-debt audit — 2026-10-06

**Scope:** `packages/*/src` = 1,435 `.ts`/`.tsx` files, ~269,600 LOC, scanned by
four parallel subagents (one quantitative cross-cutting pass + three per-package
reviews covering harness, texra+llm, and the three hosts).

## Headline

**The codebase is in good shape.** There is no large, messy area to rip out. The
things that *look* like duplication on a file listing — the 4 LLM provider
adapters, the transcript-row switches repeated across 3 hosts, the 4
`format*Event` files, the 2,400-LOC `replacement/` tables, the 7 LaTeX-binary
spawners — all already sit behind real shared seams (`assembleTurn`/`PartEvent`,
`@shared/transcript/toolRowModel`, `formatUtils`, declarative pattern tables,
`runToolWithCheck`). Marker-based debt is near-zero (the `no-warning-comments`
lint rule and `@adapter-until` ban keep TODO/FIXME/HACK out — exactly 1 real
`TODO` repo-wide), and silent-degradation smells are controlled (only 3
empty-ish `catch` blocks, all deliberate best-effort with comments).

So the findings below are the **residual high points**, not a sea of copy-paste.
Realistic total consolidation savings across the whole list are **~500–1,000
LOC** — modest against 270k. Two findings are correctness/readability plays with
little or no line savings; they are called out as such. Nothing here is urgent.

---

## Prioritized list (ranked by return on effort)

### 1. Consolidate boundary JSON parse+validate through the canonical helper — **BEST ROI**
- **Where:** `common/parsing/safeParseJson.ts` already exposes `safeParseJson` /
  `parseJsonWith<T>(text, schema)` (used by 7 files), but four boundary readers
  bypass it with bespoke `Effect.try({ try: () => JSON.parse(...) })` + hand-rolled
  error shaping: `platform/defaults/jsonStore.ts:96`,
  `common/plugins/pluginManifest.ts:124`, `tools/mcp/mcpConfig.ts:126`,
  `tools/jsonRpc.ts:169`. Two even duplicate the same "quote the parse error
  without the file text" comment.
- **Messy because:** same boundary (untrusted disk/IPC text → typed value), four
  different error types and wrappers — against the repo's own "normalize once at
  the boundary" rule.
- **Savings:** ~30–60 LOC. **Effort: S.**
- **Approach:** route all four through `safeParseJson` / `parseJsonWith`; keep only
  genuinely file-specific error annotation.

### 2. One typed XML element builder for delivery envelopes — **clean win + bug-risk removal**
- **Where:** `escapeAttr`/`escapeText` and the tag vocabulary are already SSOT'd
  (`@shared/utils/xmlEscape`, `shared/deliveryTags`) and
  `agent/runtime/deliveryEnvelope.ts:60` generalizes `<tag attrs>body</tag>` — yet
  ~5 producers still hand-concatenate element strings:
  `agent/runtime/subagentResults.ts:65`, `tools/delegation/bashDelivery.ts:70`,
  `skills/runtimeSkills.ts:298`, `agent/runtime/sessionDescription.ts:60`,
  `tools/delegation/childRun.ts:197`. The single consumer re-extracts them with
  ad-hoc regex (`shared/subagentFollowup.ts:93,259`).
- **Messy because:** the build side hand-assembles and the parse side hand-regexes
  the same envelopes — a build/parse asymmetry where a newly-added element silently
  fails to round-trip.
- **Savings:** ~80–150 LOC + removes the drift hazard. **Effort: S/M.**
- **Approach:** a tiny `element(name, attrs, children|escapedText)` builder keyed off
  the existing `DELIVERY_TAG` registry, used by every producer; have
  `subagentFollowup` parse through the same vocabulary.

### 3. Give approval/request presentation a shared row model — **completes an otherwise-finished pattern**
- **Where:** CLI `runtime/approval/approvalSummaries.ts:122` + Ink modals
  (`chat/tui/modals/`, ~2,100 LOC) vs. webview panels
  (`extension/src/progressView/frontend/components/ProposalRequestPanel.ts:122`,
  `ToolEditRequestPanel.ts`, `UserQuestionPanel.ts`, ~2,500 LOC).
- **Messy because:** every *other* transcript concern derives its displayable
  content once in `@shared/transcript`; approvals/requests are the one gap — both
  hosts independently read the same `PermissionPayload` / `AgentProposalPermission`
  / `ToolEditApprovalRequest` schemas and re-shape field selection, labels,
  file-group formatting and diff bounding. Some primitives are already shared
  (`getProposalFileGroups`, `getModelLabel`), proving the seam is half-built.
- **Savings:** ~150–300 LOC of parallel *content-derivation* logic. The divergent
  interaction layers (Ink keyboard modals vs. Lit forms) stay per-host.
- **Effort: M.**
- **Approach:** add a `requestRowModel` in `@shared/transcript` (sibling to
  `toolRowModel`) turning each permission payload into labeled sections; both hosts
  paint it, exactly as they already do for tool rows.

### 4. Factor the mirrored agent-CLI tool template (claude vs codex)
- **Where:** `tools/claudeAgent.ts:174` `runStreamedTurn` vs `tools/codex.ts:227`
  `runStreamedTurn` (same 145-line SDK-drain shape); `claudeAgentShared.ts` vs
  `codexShared.ts`; `claudeAgentConfig.ts` vs `codexConfig.ts`;
  `claudeAgentImport.ts` vs `codexImport.ts` — a mirrored 8-file, ~2,480-LOC
  template.
- **Messy because:** each `runStreamedTurn` hand-rolls the same accumulation
  scaffolding (parts/usage/sessionId/cost refs, an open-tool-card `Map`, a
  `linkAbortSignals`→`AbortController` bridge, an `Effect.ensuring` finalizer),
  differing only in the per-SDK `onMessage` switch; each `*Shared` re-implements
  "SDK item → `ToolUseLog` card" and "SDK result → `TokenUsageStats`". A shared
  layer (`agentCliShared.ts`, `externalBinaryUtils`) already exists and caps the win.
- **Savings:** ~150–300 LOC (hard-capped — the SDK event shapes and auth systems
  genuinely differ). **Effort: M.**
- **Approach:** an `AgentCliAdapter` interface (drain→events, item→card,
  result→usage, launch options) + one orchestrator; keep only SDK-specific
  translation per tool.

### 5. Shared usage-builder + input-lowering dispatch for LLM providers
- **Where:** per-provider repeats: input-part lowering
  (`api/anthropicMessages.ts:184` `inputPart` mirrored in `openrouterChat.ts`,
  `googleInteractions.ts`, `openaiResponsesLower.ts`); usage normalization
  (`anthropicMessages.ts:444` `canonicalUsage`, `openrouterChat.ts:111`,
  `googleInteractions.ts:473`, `openaiResponsesUsage.ts` — 4 functions building the
  same `TurnResult['usage']` shape).
- **Messy because:** the *output* side is beautifully centralized via
  `assembleTurn`/`PartEvent`; the *input/usage* side is not — each new provider
  re-writes the same text/image/document dispatch and the same nested
  `inputDetails`/`reasoningTokens` assembly.
- **Savings:** ~100–200 LOC (caveat: much is inherent to differing wire formats;
  the clean wins are a shared `buildUsage()` ~40–60 LOC and a `lowerInputPart`
  dispatcher ~60–100). **Effort: M (S if usage-builder only).**
- **Approach:** add a canonical-media→provider dispatch helper and a shared
  usage-builder to `api/`, mirroring `assembleTurn` for output. Leave the
  wire-decode guards alone (inherent complexity).

---

## Correctness / readability items (little or no LOC savings — noted, not sold as savings)

- **SQL read-model can drift from the typed fold (correctness hazard).**
  `agent/runtime/historyQuery/views.ts` has ~28 hardcoded
  `json_extract(data, '$.…')` paths (`$.usage.cost`, `$.outcome`, `$.identity.kind`,
  …) that re-derive facts the Zod-schema-driven folds (`runStateFold.ts`,
  `sessionFold.ts`) already compute via `z.infer`. A schema shape change updates the
  fold automatically but silently turns these paths into `NULL` — the
  "silent degradation is a defect" hazard, with no ratchet guarding it.
  **Fix:** extract the paths to schema-derived constants and/or add a ratchet test
  asserting each `json_extract` path resolves against the current event schema.
  Savings ~20–40 LOC; real value is risk reduction. **Effort: L.**

- **God functions in the run-loop core (readability/testability, LOC-neutral).**
  `agent/runtime/loop/toolUseDispatch.ts:396` `dispatchPendingResponse` (~900 lines,
  7 nested closures over shared refs); `shared/session/runStateFold.ts:367`
  `foldRow` (~460-line switch); `agent/runtime/ModelInvoker.ts` nested-closure layer
  (~600 lines); `cli/src/chat/chatSessionController.ts:312` (1,152-line closure
  factory). These are the highest-complexity spots, but restructuring is **L
  effort, ~0 LOC saved**, and the loop write-points are a documented frozen
  contract (behavior must be preserved exactly) — which is why it hasn't been done.
  Note too that AGENTS.md explicitly permits factories with captured context, so
  `chatSessionController` is a judgment call, not a rule violation. Recommend
  leaving these unless a feature forces a visit.

---

## Already-clean (checked, so the next pass doesn't re-investigate)

Cross-host tool-row rendering (shared `@shared/transcript` + thin ANSI/DOM
painters); markdown pipeline (`@ui/markdown` factory); usage/cost/context
formatting (`contextGauge`, `@utils/text`); desktop IPC (single `hostBridge`);
the GUI host-request handlers (delegate to `sharedHostRequests.ts`; overlap is
deliberate per-host divergence); settings tabs/forms (shared row widgets);
LLM output assembly (`assembleTurn`/`parts.ts`); OpenAI Responses family (size is
real complexity, not duplication); GitHub polling (`PollingSourceBase`); LaTeX
parsing/spawning (`latexParsingUtils`, `runToolWithCheck`); `replacement/` tables
(intentional declarative data); UI styles (token-driven); error classification
(single `authOrRejectionKind`).

## Suggested order

Do **1 → 2** first (both S, together ~110–210 LOC + removes the envelope
round-trip bug class). Then **3** (completes the shared-transcript pattern's one
gap, highest single LOC value at M). **4** and **5** are M-effort provider/tool
consolidations worth doing when those areas are next touched. The SQL-drift
ratchet is worth adding opportunistically (cheap test, real safety). Leave the
god-functions alone absent a forcing feature.
