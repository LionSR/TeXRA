# Declarations hand-rolled without one owner: what the 2026-11-20 audit left open

Date: 2026-11-20
Status: proposed

Origin: the scheduled audit for ad hoc and duplicated code. Four read-only
passes covered the areas prior rounds had left least touched: the webview UI
(`packages/texra/src/ui/`), the terminal (`packages/cli/src/`), the plugins and
LaTeX (`packages/texra/src/tools/`, `packages/texra/src/latex/`) and the hosts
with their controllers (`packages/extension`, `packages/desktop`,
`packages/texra/src/controllers/`). Every candidate was checked against the
other notes here and `.agents/docs/refuted-candidates.json`. The consistent
finding: the big structural debts are gone (the earlier unification rounds did
their job), and what remains is one recurring species — **a declaration idiom
written out at each call site when it has, or should have, one owner.**

The PR that adds this note lands the two instances of that species that are
behaviour-preserving and need no decision:

- **CLI flag declarations get one owner.** `boolFlag` (the off-by-default,
  no-`--no-` switch) was consolidated into `cliCommand.ts` by #15135, which
  merged first and converted the inline copies. This PR adds the companion
  `modelFlag(description)` (the optional `--model/-m`) in the same owner and
  reads the three re-authored `--model` definitions (chat, run, tasks, whose
  help text had drifted "session" vs "agent", now the one wording each surface
  passes) from it. `fileFlag` stays in `run.ts` (one file, four uses: moving it
  would be a single-caller extraction). The default-`true`/optional switches
  (`--color`, `--pr`, `--gitignore`) keep their own `Flag.Boolean`, since they
  are a different shape.
- **Optional tool-input fields get one owner.** `optionalInput(schema, description)`
  in `packages/harness/src/tools/core/inputSchema.ts` (exported from
  `@texra-ai/harness/plugins` beside `nullishWithDefault`) is the no-default
  counterpart to `nullishWithDefault`: `Schema.optional(Schema.NullOr(schema)).annotate({ description })`,
  the nullable-optional shape the root AGENTS.md "Tool input schemas" rule
  requires. It replaces the private `optionalFlag` in `documentTools.ts` and the
  hand-rolled copies in every built-in tool that carries a described optional
  field where the description sits on the **outer** `Schema.optional(...)` —
  the shape `optionalInput` reproduces. That is the built-in tools — harness
  (`EditTool`, `ReadTool`, `bash`, `grep`, `glob`, `ScriptTool`,
  `executions/toolInput`, `formatting`, `memory`, `WebFetchTool`) and the
  delegation tools (`AgentTool`, `ProgramTool`, `codemode/SelfTool`, and the
  shared `CHILD_FIELDS` / `CALL_FIELDS` / `personaField` / `workingDirectoryField`
  in `agent/runtime/delegation/inputFields.ts`) — and the plugins
  (`AcceptRunFilesTool`, `claudeAgent`, `codex`, `ArxivSearchTool`,
  `githubSubscriptionTool`, `ProbeEnvironmentTool`, `UserQuestionTool`,
  `comment/InlineCommentTool`). The compiled JSON Schema is byte-identical, so
  no recorded tool definition changes. Three shapes keep the raw form: a field
  with **no** description (`view_range`, `memory`'s `new_str`), since
  `optionalInput` is for the described case; a field that annotates the **inner**
  schema inside `NullOr` rather than the outer optional (the whole Zotero tool
  family — see Open 5 — where moving the description outward is not a guaranteed
  byte-identical schema change); and the wire and response schemas (`bbtClient`,
  `prTypes`, the GitHub and Zotero response structs, `LoogleTool`'s hit and
  error structs, `codexConfig`'s bundled-model parse), which decode external
  JSON, where the nullable-optional rule — about what a model sends — does not
  apply.

## Open

Each needs a decision or a check this unattended run could not make.

1. **The CLI refuses a usage error two ways.** `cliCommand.ts` already catches
   `CliUsageError` and writes its message to stderr and returns
   `CliExitCode.Usage` (`report`, and the parse's `catch`); it is the owner of
   "refuse with a usage error". Yet ~15–24 command sites inline
   `writeTextStderr(msg); return CliExitCode.Usage` instead (agents — a private
   `refuse()`, history, models, resumeRun, installGithubAction, executeCli,
   clone). The clean fix routes the standalone usage refusals through
   `CliUsageError` (not a third helper). It needs per-site care: several sites
   return `AgentError`, not `Usage`; some sit inside an `Effect.catch` that must
   yield a recovery value; and `runHistoryDelete` returns `Usage` after emitting
   a structured result, which is control flow, not a usage error. Decide the
   mechanism (route to `CliUsageError`, or a `refuseUsage(msg): number`
   extraction) and convert only the sites that qualify.

2. **No shared Lit base class.** Across `packages/texra/src/ui/progress/components/`
   and `packages/texra/src/ui/settings/`, 50 components open `static styles`
   with `designTokens`, 53 import `commonViewStyles`, 33 repeat
   `:host { display: block; }`, and 63 `@customElement` classes extend
   `LitElement` or `SignalWatcher(LitElement)` directly — there is no
   `TexraElement` / `TexraSignalElement` base. A base whose
   `static styles = [designTokens, hostBlock]`, with subclasses doing
   `static styles = [...TexraElement.styles, ...own]`, removes ~130–180 lines
   and is the one home for future shared behaviour. This supersedes the
   narrower `:host{display:block}` (28) and `designTokens, commonViewStyles`
   (20) items in `2026-11-19-helpers-written-by-hand-left-open.md`, whose scope
   was understated. A follow-on: `truncateDeclarations` / `overlineDeclarations`
   / `panelFrameStyles` are `${...}`-interpolated into per-component selectors
   (~37 sites, 24 files) instead of exposed as `.truncate` / `.overline`
   utility classes in `commonViewStyles`. Both need a visual check of both
   webviews (host-block and token ordering can shift layout) and a decision on
   whether `commonViewStyles` belongs in the base.

3. **The attention follower is reimplemented per GUI host.** Both hosts hand-roll
   the same loop — subscribe to the session view, call the shared `attentionOf`,
   diff a cached badge count, dispatch arrived/finished — differing only in the
   host surface: `ProgressViewProvider.followAttention` / `setBadge` (extension)
   and `followDesktopAttention` / `electronAttentionPort` (desktop). A shared
   `followAttention(views, port)` in `controllers/session`, over a host port of
   `setBadge` / `revealArrived` / `announceFinished` / `dismiss`, removes
   ~40–60 lines and hands the already-open "which finished run does each host
   announce" decision (extension chimes only a completed document task; desktop
   notifies every top-level run) one owner. The helper must take a stream of
   `[view, previous]` tuples: the desktop follows many projects, the extension
   one session.

4. **Request-failure and decode mapping differ per network client.** Each
   external client answers "timed out / unreachable" and "unexpected response
   shape" its own way: `zotero/bbtClient.ts` (`Cause.isTimeoutError` +
   `isTransportReason`, after `withRequestTimeout`), `lean/LoogleTool.ts`
   (`Cause.isTimeoutError` → `errorResult`, after `retryTransientFetch`) and
   `arxiv/ArxivSearchTool.ts` (`Effect.timeoutOrElse` + `ToolError`, a third
   idiom). A `requestFailureToToolError` / `decodeBoundary(schema)` would keep a
   fourth integration from inventing a fourth convention; the per-tool guidance
   text stays per-caller. Needs a decision on the one convention (the
   user-facing error strings would shift slightly).

5. **The Zotero tools annotate the inner schema, not the outer.** Every input
   field in `ZoteroSearchTool`, `ZoteroAddTool`, `ZoteroCollectionsTool` and
   `ZoteroExportTool` is written `Schema.optional(Schema.NullOr(S.annotate({
   description })))` — the description on the inner `S`, inside `NullOr` — where
   the rest of the tree, and `optionalInput`, put it on the outer
   `Schema.optional(...)`. The two produce the same decoded and encoded types,
   but whether `convertToolSchema` renders byte-identical model JSON for the
   inner- and outer-annotated forms was not verified this run, so these were not
   converted (a changed tool definition is a format change). Confirm the
   generated schema is identical for both placements; if it is, convert the
   Zotero family to `optionalInput` too, and if it is not, the inner form is the
   one to keep and `optionalInput` is for the outer case only. Their item and
   response structs (and `bbtClient`) stay raw regardless.

## Checked and found clean (so a later run need not re-dig)

- **UI** (`ui/copy/`, `ui/formatting/`, `uiEvents.ts`, markdown, the control
  stylesheet, time/byte/plural formatters, details toggling, host messaging,
  banners/empty-state/filter/pagination): already single-owner. No render-time
  compensation (`Date.now()` only in the one ticker; the `Set`/`repeat()` cases
  are domain logic and real list keys).
- **CLI** transcript rendering (one paint of `toolRowModel`), the `/` forms
  (`forms/_shared/*` absorb load/write/key-replay), scroll handling, signal
  wiring (`cliState` `fieldOf`), and the headless output switch (`cliResult` /
  `emitCliResult`): single-sourced.
- **Plugins**: subprocess spawning (`runTool`), HTTP (`scopedOkClient` /
  `retryTransientFetch`), the GitHub pollers (`pollTarget`), the agent-CLI pair
  (`availabilityProbes`, `agentCliShared`), LaTeX parsing
  (`latexParsingUtils`), and the toolchain constants are already shared. The
  `claudeAgent*` / `codex*` split is two genuinely different CLIs.
- **Hosts**: the `host.request` router (`openGuiWindow` owns the switch; the two
  host files are binding tables), the command catalog, the error lifts
  (`hostCallFailure`), and the dialog adapters are single-owner or a correct
  adapter boundary. The desktop's `!window.isDestroyed()` guards (~18 sites)
  each do something different; a `whenAlive` helper would collapse only a
  subset and was not judged worth it.
