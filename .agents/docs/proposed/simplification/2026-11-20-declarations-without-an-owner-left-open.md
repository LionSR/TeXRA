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

- **CLI flag declarations get one owner.** `packages/cli/src/commands/_helpers/flags.ts`
  holds `boolFlag` (the off-by-default, no-`--no-` switch) and `modelFlag(description)`
  (the optional `--model/-m`). The private `boolFlag` in `cliCommand.ts`, its
  verbatim copy in `history.ts`, the ten inline copies (agents, doctor ×2, init
  ×2, installGithubAction, models, resume, subscriptionAuthCommand ×2) and the
  three re-authored `--model` definitions (chat, run, tasks, whose help text had
  drifted "session" vs "agent", now the one wording each surface passes) all
  read from it. `fileFlag` stays in `run.ts` (one file, four uses: moving it
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
  field — harness (`EditTool`, `ReadTool`, `bash`, `grep`, `glob`,
  `ScriptTool`, `executions/toolInput`, `formatting`, `memory`, `WebFetchTool`)
  and plugins (`AcceptRunFilesTool`, `claudeAgent`, `codex`, `ArxivSearchTool`,
  `githubSubscriptionTool`, `ProbeEnvironmentTool`, `UserQuestionTool`). The
  compiled JSON Schema is byte-identical, so no recorded tool definition
  changes. A field with **no** description (`view_range`, `memory`'s `new_str`)
  stays the raw `Schema.optional(Schema.NullOr(...))`: `optionalInput` is for the
  described case, and inventing a description for it would be worse. Wire and
  response schemas (`bbtClient`, `prTypes`, the Zotero and GitHub response
  structs, `LoogleTool`) keep the raw form: they decode external JSON and the
  nullable-optional rule, which is about what a model sends, does not apply.

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
