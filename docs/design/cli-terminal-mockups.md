# CLI terminal mockups — design brief and style contract

Internal brief (srcExcluded) for the docs-wide CLI mockup pass. The docs site
explains concepts through live Vue mockup components, but ~87 of them serve the
VS Code extension and only 3 served the CLI. This pass gives the `texra` CLI
equal explanatory weight where it genuinely carries the concept — one terminal
card per endorsed page, nothing on pages where a CLI mockup would be clutter.

## Balance philosophy

- One CLI mockup per page, placed where the page's CLI claim is actually made.
- Never replace a GUI mockup; the CLI card complements it (parity, not takeover).
- Pages whose surface is genuinely GUI-only (progress-board webview internals,
  merge pairing, drag-and-drop) keep their GUI mockups unchallenged.
- Cross-link instead of duplicating: if a concept already has its CLI visual on
  another page, a caption link suffices.

## House rules (non-negotiable)

1. **Mockup-native**: live DOM components, never screenshots or images.
2. **Theme-adaptive**: every color from `--mk-*` tokens (or the sanctioned
   aliases `--color-success/-warning/-error`, `--color-text-*`, `--brand`,
   `--wa-color-text-normal`) or `color-mix()` over them. No hex/rgb literals,
   no `html.dark` selectors in components — dark mode must come for free.
3. **No hardcoded dimensions**: padding/gap/margin/size/radius/font-size from
   `--mk-space-N` / `--mk-size-N` / `--mk-radius-*` / `--mk-fs-NN` /
   `--vp-font-family-*`. Sanctioned literals only: `1px` hairlines, `@media`
   breakpoints (560px component-level, 820px shared), unitless line-heights,
   font weights, `50%` for circles.
4. **Static figures**: no `Date.now()`, no current-looking timestamps, no
   random ids, no component-local reactive state/watchers/lifecycle. Motion
   only via shared keyframes (`mk-spin`, `mk-shpulse`, `mk-blink`) and the
   bridged `<wa-spinner class="… mk-spinner">`.
5. **Compose, don't re-roll**: titlebar via `.mk-term-*`; terminal cards via
   `<TermWindow>`; pills via `<StatusPill>`; inline-header cards via
   `<MockCard>`. Never copy-paste shared chrome CSS.
6. **Root contract**: `<div class="mockup <prefix>" role="group"
aria-label="…">` (TermWindow provides this for terminal cards). Unique
   short class prefix per component; all styles `<style scoped>`.
7. **Header comment contract**: each component opens `<script setup>` with a
   comment stating what it shows, which doc section/prose it makes concrete,
   and that it is `.mockup`-scoped / theme-adaptive. Believable static strings
   copied from real product output; never invented flags or commands.
8. **Frameless preferred**: terminal titlebar chrome only when the figure IS
   terminal output. Comparisons/stacks stay frameless (cf. CliAuthModesHero).
9. **Registration**: page-specific heroes are imported per-page in the .md
   `<script setup>` with relative paths (`../.vitepress/components/X.vue`).
   Only reusable primitives (TermWindow) are registered globally in
   `theme/index.js`.

## Shared terminal primitives

CSS in `docs/.vitepress/theme/mockup.css` (added by the foundation pass,
next to `.mk-term-bar`):

- `.mk-term-card` — card shell: `--mk-bg` background, 1px `--mk-border-soft`
  border, `--mk-radius-lg`, `margin: var(--mk-space-12) 0`, overflow hidden,
  base font `--vp-font-family-base`.
- `.mk-term-body` — recessed mono body: `--mk-bg-deep`, padding
  `--mk-space-12/14`, `--vp-font-family-mono`, `--mk-fs-78`, line-height 1.6.
- `.mk-term-hint` — bottom strip: flex, `--mk-bg-soft`, 1px top hairline.
- `.mk-term-prompt` / `.mk-term-sigil` / `.mk-term-cmd` / `.mk-term-flag` —
  prompt line: `$` sigil in `--mk-syn-fn` bold; command `--mk-text`; flags
  `--mk-syn-comment`.

`<TermWindow>` (globally registered, MockCard's terminal sibling):

```vue
<TermWindow title="texra run" aria-label="texra run streaming output">
  <!-- default slot renders inside .mk-term-body -->
  <template #hint><!-- optional .mk-term-hint strip --></template>
</TermWindow>
```

Props: `title` (mono window title = the command being demonstrated),
optional `ariaLabel` (defaults to title). No density/variant props — body
content (prompt lines, rows, tables, diffs) is per-hero.

## Real CLI vocabulary (fact-checked against packages/cli source)

Use ONLY these; never invent flags, commands, or output shapes.

**Headless text output**: `texra run <agent> --input/-i <file> [--context/-c]
[--output | --output-dir] [--model/-m] [--instruction]` prints progress to
stderr and, in text mode, a final filesystem path on stdout (the copied
`--output`/`--output-dir` path, else the generated file in run storage under
`…/executions/<id>/r0/…`). Repeated `--input` for multi-file; `--output` is
single-input only. `--print/-p`, `--output-format text|json|ndjson`,
`--no-input` (forces approval policy `never`). Exit codes: 0 ok, 1 agent,
2 usage, 3 model/network, 4 approval denied.

**Rounds**: workflow runs show round progress (r0 draft → r1 critique for
polish). Run storage tree: `.texra/runs/<run-id>/r{n}/` (PolishRunTree shows
this on first-run.md). Round folders keep the INPUT filename (`r1/draft.tex`,
not `output.tex`). Execution/run ids are compact 12-char hex
(`src/utils/core/executionId.ts`), e.g. `9f3a6c81d24e` — use that shape in
mockups, never `run-123` or named ids.

**List output formats** (tab-separated, stable):

- `texra agents list` → `<category>\t<name>\t<description>` (workflow/toolUse)
- `texra agents show <name>` → `name:`, `category:`, `source:`, `path:` lines
- `texra history list [-n N]` → `<id>\t<timestamp>\t<agent>\t<status>\t<input>`
- `texra history show <id>` → details + `Files (N):` listing with sizes
- `texra models list` → `<value>\t<label>\t<status>` where status is the
  lowercased availability label for the current api mode (e.g. `fable5  Claude
Fable 5  included access`; personal mode prints `api key set` /
  `openrouter key`; `--all` adds `login required` / `not included`);
  `texra models show <id>` → detail lines
- `texra memory list` → `Memories (N):` header then `/memories/<file>` rows
  with pinned state + size; `texra memory show memories/<file>` previews one
- `texra tools list` → SIX columns `ID NAME CATEGORY ENABLED DETECTED NOTE`,
  booleans as `yes`/`no`/`-`; subcommands `show|status|enable|disable|
install [--run]|auth`
- `texra multi-agent list|show|run` — teams: Lean Project, Physicist,
  Mathematician, Computer Scientist, Software Engineer; show resolves lead +
  specialists
- `texra doctor` → grouped PASS/WARN/FAIL rows (Node, dirs, auth, model
  access, LaTeX toolchain: latexmk, pdflatex, latexdiff, latexindent…)

**Auth**: `texra login [github|google] [--device] [--no-browser]`;
`texra auth` = status (`Signed in as <label> (<tier>).`); `texra setup-token
[--name --expires --print-env]` (CI relay token → `TEXRA_RELAY_TOKEN`);
BYOK via `ANTHROPIC_API_KEY` etc.; `--api-mode personal|included`.

**Interactive TUI** (`texra chat [--agent X] [--model Y]`) — REAL elements:

- Session header: cyan rule, bold cyan `{ T } TeXRA` + dim `v0.x` + dim
  api-mode (`relay`/`keys`), printed once at top.
- User turn: reverse-video band with `› ` chevron prefix. NO name chips.
- Assistant turn: plain markdown text, unlabeled. "thinking…" lives in the
  status bar (yellow), never inline next to text.
- Tool-call row: `● <ToolName> (<preview>)` — dot dim while running, green
  done, red error; tool name bold; preview = command/path/query in parens.
  An in-flight row keeps the dim ● dot (no spinner in the row).
- Tool output: indented under `⎿ ` corner glyph, dim, elided to head/tail
  with `… +N lines (ctrl + t to view transcript)`.
- Diffs: full-width colored bands — green `+` added, red `-` removed, dim
  context. NEVER strikethrough.
- Status bar: cyan `◆`, status label, `Ns` elapsed, dim api-mode, `rN` round
  counter, token usage `12.3k/200k (6%)`; second row = bracketed bindings
  like `[/status]details  [/model]models  [/api]api  [Ctrl-J]newline
[Ctrl-C]exit`.
- Input bar: rounded gray-bordered box with cyan `›` prompt; dim
  `Tip: …` row above when idle.
- Subagents: numbered child rows with status marker, label, elapsed, dim
  output tail lines; `[Tab]streams` to focus.
- Slash commands (real set): /help /clear /agent /model /api /auth /login
  /logout /approval /yolo /status /resume /memory /skills /tools /compact
  /exit.
- Defaults: chat agent `assistant`, model `deepseekT`. `--agent research`
  valid (tool-use). `texra resume <id>` is interactive-only (reopens the TUI;
  never depict it as headless).

**Status colors in mockups**: done dot `--color-success`; warn
`--color-warning`; error `--color-error`; in-flight = dim dot or
`<wa-spinner class="… mk-spinner">` where the real UI shows elapsed motion
(status bar / round rows), per existing component precedent.

## Component roster

Foundation: `TermWindow.vue` (+ mockup.css classes), `CliRunHero.vue` (shared
streaming-run card; props `command`, `rounds` `[{label, state:
'done'|'active'}]`, `outputs` `string[]`, optional `note`), rebuilt
`CliChatHero.vue` (real TUI vocabulary), `CliToolsListHero.vue` (TermWindow +
NOTE column).

Per-page heroes (one page each unless noted): `RunParityHero` (guide/index),
`CliInitHero` (configuration), `DoctorSliceHero` (props-driven; troubleshooting

- latex-compilation + latex-tools), `CliAgentsListHero` (built-in-agents),
  `CliAgentShowHero` (custom-agents), `CliMemoryHero` (memory), `CliHistoryHero`
  (progress-board), `CliStorageHero` (file-management), `CliToolsLifecycleHero`
  (agent-integrations), `CliModelsHero` (models), `CliRemoteHero`
  (remote-agents), `CliSearchChatHero` (research-tools), `CliLeanHero` (lean),
  `CliMultiAgentHero` (texra-cli), landing CLI strip (root index.md).

CliRunHero reuse: quick-start, first-run, polish-a-draft, texra-cli,
agent-architecture, multiple-output (multi-input variant), working-with-figures
(figure-caption variant: vision reaches the model via figures auto-extracted
from the _input_ document on round 0 — `--context` is text-only; never imply
vision via `--context`).

Explicit skips (decided, don't revisit): best-practices, intelligent-merge,
code-review, open-source, acknowledgments, providers.md, launch.md,
installation (DoctorReportCard already serves it), tikz-figures (bash-block tip
only), built-in-agents Teams section, troubleshooting history card
(cross-link to progress-board instead), texra-cli device-login card.
