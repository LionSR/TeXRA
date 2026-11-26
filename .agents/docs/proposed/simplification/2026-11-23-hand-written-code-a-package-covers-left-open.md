# Hand-written code a package covers: what the 2026-11-23 audit left open

Date: 2026-11-23
Status: proposed

Origin: the scheduled audit for brute-force or ad-hoc code that a
well-maintained npm package (first of all one already installed), a Node
builtin or Effect would replace. One read-only sweep covered every
package's `src`, `scripts/` and `supabase/functions/` for twelve families
(byte, duration and relative-time formatting; ANSI and terminal width;
semver; MIME and HTTP status tables; caches; globs, ignore files and paths;
argument and shell parsing; HTML and URL escaping; JSON and cloning; retry,
SSE and encoding helpers; BibTeX and identifiers; frontmatter, wrapping,
archives). Each candidate was then read against the code,
`.agents/docs/refuted-candidates.json`, the open PR (#15196) and the
earlier notes in this directory.

Most families are already on a package or a builtin: `pretty-bytes`,
`Duration.format`, `Intl.RelativeTimeFormat`, `stripVTControlCharacters`,
`string-width` / `wrap-ansi` / `slice-ansi` / `cli-truncate`, Effect
`SemVer`, `http-status-codes`, `lru-cache`, `pathe`, `ignore`,
`node:util` `parseArgs`, `yaml`, Effect `Tar`, `safe-stable-stringify`,
`diff-match-patch`, `Schedule`. No hand-written SSE parser, JSONC stripper,
deep-equal, deep-clone, debounce, CSV reader, port finder or lock file
exists.

The PR that adds this note lands one finding:

- **GitHub query strings.** Every GitHub GET concatenated its own
  `?per_page=…&since=…`; `withSince` picked `?` or `&`, the repository
  poller wrote `&since=` itself, and the current-branch lookup left the
  owner in `head=` unencoded. `ghGet` and `pollGet` take `params` and
  Effect's `HttpClient` encodes them (`urlParams`); `githubPaths.ts` is
  deleted. The requests on the wire are the same, parameter for parameter.

## Open

Ranked by the code each would replace. npm's download counts could not be
read from this run (`api.npmjs.org` is outside the session's network
policy); release dates are from `registry.npmjs.org`.

1. **HTML in a model's markdown, rewritten by regular expressions in the
   terminal client** (`packages/cli/src/chat/tui/render/htmlMarkdownNormalize.ts`,
   463 lines, one caller in `transcriptEntries.ts`). About thirty patterns
   (an HTML attribute grammar among them) turn `<strong>`, `<em>`, `<code>`,
   `<p>`, `<div>`, `<br>`, `<h1>`–`<h6>` and `<blockquote>` into markdown
   before markdown-it parses the text, and two thirds of the file shields
   math, currency and shell `$` from those patterns.
   - Candidate: **markdown-it** itself
     ([npm](https://www.npmjs.com/package/markdown-it), 15.0.3, published
     2026-10-16, already a dependency of the CLI and the app). With
     `html: true` it tokenizes these tags as `html_inline` / `html_block`,
     and `ansiMarkdown.ts` would map the known tags to the styles it
     already emits. The tokenizer knows where code spans and math end, so
     the shielding has nothing left to protect.
   - Not **turndown**
     ([npm](https://www.npmjs.com/package/turndown), 7.2.5, published
     2026-11-04, already a harness dependency): it takes a whole HTML
     document, would escape the markdown around the tags, and brings a DOM
     into the CLI bundle.
   - Needs a decision: the shared renderer sets `html: false`
     (`packages/texra/src/ui/markdown/createMarkdownRenderer.ts`) so a
     webview never renders a model's HTML. The terminal would need its own
     instance or a rule over the tokens, and the golden TUI frames checked
     for every tag.
   - Taken on 2026-11-24: the normalizer is deleted. The terminal's own
     markdown-it instance sets `html: true` with `html_block` off, and a
     core rule in `ansiMarkdown.ts` (`applyHtmlTags`) turns each known tag
     into the token its markdown equivalent produces: paired `<strong>` /
     `<b>` / `<em>` / `<i>` into emphasis, `<br>` into a hard break, and
     `<p>`, `<div>` and paired `<h1>`–`<h6>` / `<blockquote>` into the
     paragraph, heading and blockquote blocks the paragraph is split into
     (`<blockquote>` and `<h1>`–`<h6>` pair across paragraphs, so a quote or
     heading with blank lines in it covers each one). A `<code>` element becomes a backtick code span
     in the inline source before inline parsing (`codeElementsToSpans`), so
     its body prints as written. Any other tag, and an
     unpaired one, prints as its text. Math needs no second shield: the
     render shield already sets math aside before markdown-it parses; it
     now ends a `$…$` candidate at a `<code>` element or a closing tag the
     terminal styles, so `<code>$HOME</code> or <code>$PATH</code>` stays
     two shell variables. The shared web renderer keeps `html: false`.

2. **A JavaScript lexer for a program file's header**
   (`readDeclarations` in
   `packages/harness/src/common/plugins/pluginPrograms.ts`, about 135
   lines). A cursor walks whitespace, comments, quoted literals with
   escapes and `[...]` lists to read `export const description` and
   `export const uses` without running third-party code.
   - Candidate: **acorn**
     ([npm](https://www.npmjs.com/package/acorn), 8.19.0, published
     2026-10-05, no dependencies; 8.18.0 is already in the lockfile as a
     transitive dependency). Parsing the module and checking that the first
     two statements are `export const` of a string `Literal` and an
     `ArrayExpression` of them is about twenty lines.
   - What it changes: a parser reads the whole file, so a syntax error
     anywhere refuses a program whose header is fine, where the cursor
     stops after two statements. It is also a new dependency of the
     published SDK. Both are the owner's call.

3. **base64url and hex written by hand in the device-flow function**
   (`supabase/functions/auth-device/crypto.ts`). `randomBase64Url` builds a
   binary string for `btoa` and rewrites three characters; `sha256Hex` pads
   each byte.
   - Candidate: `jsr:@std/encoding` (`encodeBase64Url`, `encodeHex`), or
     `Uint8Array.prototype.toBase64({ alphabet: 'base64url', omitPadding:
     true })` and `toHex()` once the Edge runtime's Deno has them.
   - Not done here: no Deno runs in this session, so neither the import
     map change nor the runtime's support could be checked.

4. **CORS headers written by hand** (`supabase/functions/_shared/cors.ts`,
   73 lines). `auth-device` already serves through `@hono/hono`, whose
   `hono/cors` covers it; the other functions are not Hono apps, so this
   follows moving them, not the other way round.

## Checked and declined

- **`Jwt.decodeUnverified` (`effect/jose`) for
  `decodeJwtClaimsWithSchema`** (`packages/llm/src/oauth/jwtDecode.ts`,
  six lines of body). It returns an Effect, and both callers are the
  synchronous `buildSession` of the subscription coordinator; making that
  effectful to save a `split('.')` is the larger change.
- **`semver` for `scripts/release-version.mjs`.** The script states that
  it needs only Node because the release jobs run it before the workspace
  is installed, and it accepts only `X.Y.Z` and `X.Y.Z-preview.N`, which a
  general semver parser would widen.
- **`OFFICE_MIME_TYPES` derived from `OFFICE_EXTENSIONS` through
  `mime-types`** (`packages/harness/src/utils/files/mimeUtils.ts`). The
  MIME set is not a second spelling of the extension list: `mime-types`
  maps `.dot`, `.xlt`, `.pps` and others to the same types, and the read
  tool accepts those through the MIME set.
- **`slice-ansi` for `splitRawAtVisiblePrefix`**
  (`packages/cli/src/tui/ansiWrap.ts`). It needs the raw bytes of the
  prefix; `slice-ansi` re-emits the open styles on each side. The tokenizer
  under it (`ansiEscapes.ts`) also serves the streaming no-color stripper,
  which must hold a sequence split across two writes and so cannot use
  `stripVTControlCharacters`.
- **`cli-truncate` for `truncateLineToWidth`**
  (`packages/cli/src/runtime/approval/approvalSummaries.ts`). The limit
  there is a character budget on what an approval prompt holds
  (`boundedLines` counts `length`), not a column fit.
- **`mime-types` for the pasted-image table**
  (`packages/texra/src/ui/progress/clipboardImages.ts`). Webview code;
  `mime-types` requires `node:path` and all of `mime-db`.
- **`cross-spawn` for `escapeCmdArgument`**
  (`packages/harness/src/utils/system/windowsCommandLine.ts`). Ten lines
  kept so every spawn stays on Effect's `ChildProcess`.
- **`lru-cache` for `digestMemo` and the Anthropic thread map**
  (`packages/llm/src/api/`). llm does not depend on `lru-cache`, and the
  thread map looks up by prefix and removes on read (declined for Effect
  `Cache` on 2026-11-20 for the same reason).
- **`vscode-jsonrpc` for the `Content-Length` framing**
  (`packages/harness/src/tools/jsonRpc.ts`). A new dependency for 45
  lines; the quadratic copy in `takeFrames` is item 3 of the 2026-11-22
  consolidation note.
- **`StatusCodes.OK` for the `200` / `304` the pollers compare.** Those
  are the discriminant of `ConditionalResponse`, a union this code
  defines, not a status read off a response.
- **`minimatch.braceExpand` in `scripts/check-guidance-refs.mjs`** and
  **`pretty-bytes` in `scripts/verify-desktop.mjs`**: neither package is a
  root dependency, and each helper is under fifteen lines.

## The 2026-11-25 run

Two read-only sweeps (the harness and llm; the app, the hosts, `scripts/`
and `supabase/functions/`) over the families the first run did not name:
fuzzy matching and edit distance, natural sort, plural and list wording,
number, percent and date formatting, grapheme segmentation, regex escaping,
stream collection, ids and hashes, deep merge and clone, `.env` and XML
parsing, git output, process trees, executable lookup, file watching,
debounce and polling, line diffs, templates, URL and header parsing, array
grouping and chunking, caches, key parsing, colour maths, DOM helpers,
syntax highlighting, shell completion, opening URLs and temp directories.
Each is on a builtin, `Intl`, Effect or an installed package already. The
paths #15229 and #15230 delete were left out.

Landed, all small:

- **One natural-sort collator for the file tree.** The main process sorted
  each directory listing with `localeCompare(…, { numeric, sensitivity })`
  and the renderer sorted it again by the same rule, directories first.
  The listing now comes as the file system returns it and `editorTree.ts`, the one
  place that shows it, compares through one `Intl.Collator` instead of
  building a collator on every comparison.
- **`collapseWhitespace` for four inline copies** of
  `replaceAll(/\s+/g, ' ').trim()` in the harness.
- **The run listing sorts on `launchedAt`** before it reads each run,
  instead of parsing the ISO text it had just written, twice per
  comparison.
- **The quota percentage is the rounded number.** A value rounded to one
  decimal already prints as `toFixed(1)` would, so the integer check and
  its two branches were one template.

### Checked and declined on 2026-11-25

- **`JsonPointer.parseUriFragment` (Effect) for the `$ref` walk in
  `typeOf`** (`packages/harness/src/tools/codemode/declarations.ts`). It
  decodes `~1` and `%XX`, which the `split('/')` does not, but it returns
  `undefined` for a fragment holding a character that should have been
  percent-encoded, and a third-party tool's `#/$defs/Some Name` resolves
  today.
- **minisearch for the BM25 ranker in `searchTools`**
  (`packages/harness/src/tools/codemode/discovery.ts`, about 49 lines).
  It scores with BM25+ under other constants, so rankings change; the
  tokenizer, stop words and plural rule would stay; and it is a new
  dependency of the published SDK.
- **`Intl.NumberFormat` for `formatCompactTokenCount` and
  `formatCostUsd`.** Compact notation prints `12K` where the code prints `12k`, and
  `4.1K` for 4097 where it prints `4k`; the
  raw-until-4096 rule stays; the currency style adds group separators and
  moves the minus sign.
- **An image package for `gifFrameCount`**
  (`packages/llm/src/api/openaiResponsesCodec.ts`). llm has none, and
  `image-size` in the harness reports dimensions only.
- **`diff` or `node-diff3` for `mergeEditOnto`**
  (`packages/harness/src/tools/unifiedDiff.ts`). jsdiff 9 has no `merge`,
  and neither applies the rule that touching edits conflict.
- **The string case of `toUint8Array`**
  (`packages/harness/src/tools/emlParser.ts`). postal-mime's default
  returns an `ArrayBuffer`, so the base64 line never runs, but its type is
  still the three-way union and the narrowing would stay.
- **`cli-truncate` with `position: 'start'` for `leadingEllipsisDisplay`**
  (`packages/cli/src/chat/tui/input/textInputDisplay.ts`). The marker is
  shown even when the text fits, and the caller needs the count of code
  units removed, so both ends stay hand-written.
- **highlight.js's `diff` grammar for `getDiffLineClass`**
  (`packages/texra/src/ui/progress/formatters/htmlBuilders.ts`). About 25
  lines against a new grammar in the webview bundle and restyled classes.
- **The `open` package for `packages/cli/src/runtime/models/browser.ts`.**
  It spawns outside Effect's `ChildProcess`, the reason `cross-spawn` was
  declined.
- **`disposable-email-domains-js` for the sign-up blocklist**
  (`supabase/functions/before-user-created/emailPolicy.ts`). The list is
  the 32 domains seen farming accounts; the package's tens of thousands
  would change who can sign up, which is a policy decision.
- **`nanoid`'s `customAlphabet` for `randomUserCode` and `jsr:@std/html`
  for `escapeHtml`** (`supabase/functions/auth-device/`,
  `supabase/functions/auth-bridge/`). They join open item 3: no Deno runs
  in these sessions to check an import map change.

This theme has now been read three days running and the last two runs
found under a hundred lines between them. What is left is items 2 to 4
above, each waiting on a decision or a Deno runtime.

## The 2026-11-26 run

Two read-only sweeps (the hosts and scripts; the harness, llm, the app and
`supabase/functions/`) over families no earlier run named: terminal control
sequences, capability and CI detection, the clipboard, spinners and
symbols, key parsing, update checks, config directories, TOML and INI,
tables, colour maths, Electron window state and settings, archives and
downloads; partial JSON, response headers, file-type and charset sniffing,
HTML entities, indentation, patch parsing, OAuth, proxies, address checks,
token estimates, JSON Schema walking, Office and PDF reading, markdown by
regex, cron and durations, queues and graphs, locks and timeouts. Each is
on a builtin, Effect or an installed package already, except the items
below.

Landed:

- **The desktop dev launcher starts Vite through its API.**
  `packages/desktop/scripts/dev.mjs` found a free port by opening and
  closing a socket, spawned the Vite CLI on it through the package manager
  and fetched the URL up to a hundred times until it answered. It calls
  `createServer` and `listen` from **vite**
  ([npm](https://www.npmjs.com/package/vite), 8.3.8, already a desktop
  dependency), as `tests/e2e/devStartup.spec.ts` does: Vite binds port 0
  and `listen` resolves when it serves. The main-process watcher is started
  as its own Node process, so the stop signal reaches it; started through
  `pnpm run`, it outlived the launcher. The `watch:main` script, whose one
  caller was the launcher, is gone.

### Open after 2026-11-26

5. **Job-control suspend re-implements Ink's `suspendTerminal`**
   (`packages/cli/src/tui/terminalCleanup.ts`, the `suspend` / `resume`
   pair and `KITTY_PUSH_DISAMBIGUATE` / `REARM_INPUT_MODES`, about 30
   lines, with the kitty flags `runChatTui.tsx` passes to keep them in
   step). **ink** 8 ([npm](https://www.npmjs.com/package/ink), already the
   CLI's renderer) pops and re-pushes the kitty flags it was given, turns
   raw mode and bracketed paste off and on, and redraws; a callback that
   stops the process and resolves on `SIGCONT` would put Ctrl-Z on it.
   `release` stays: the `exit` hook must be synchronous. Ink also erases
   its frame on suspend, which the hand-written path does not, so this
   needs Ctrl-Z and `fg` tried in a real terminal, more than one emulator.
6. **An arXiv source's extension is read from the content type by
   substring** (`getExtensionFromContentType` in
   `packages/texra/src/latex/arxivProcessor.ts`): `includes('tex')` is true
   of `text/html`, so an HTML page answered with 200 and no
   `Content-Disposition` would be saved as `.tex`. Compare the media type
   (the text before `;`) instead. Both open PRs edit the file; take it
   after them.

### Checked and declined on 2026-11-26

- **markdown-it for the link and heading reader in
  `scripts/check-guidance-refs.mjs`** (about 137 lines) and the fence
  tracking in `scripts/check-proposal-status.mjs`. Both scripts state that
  they run on bare Node before anything is installed, and markdown-it is
  not a root dependency.
- **`Codegen.propertyKey` and `Codegen.docComment` (Effect) for the key
  quoting and doc comments in
  `packages/harness/src/tools/codemode/declarations.ts`.** Both are marked
  experimental, `docComment` takes no indent, and together they replace
  about fifteen lines.
- **`RcMap` (Effect) for `withPerKeyLane`**
  (`packages/harness/src/utils/core/perKeyQueue.ts`). The callers pass
  their own `Map` or `WeakMap` and rely on the key's lifetime; `RcMap`
  would make each call scoped.
- **markdown-it for `collectLatexFencedBlocks`**
  (`packages/texra/src/agent/output/extraction/contentSimilarity.ts`). It
  departs from CommonMark on purpose: fences at any indentation, an
  unclosed fence dropped and reported, a longer fence restarting the block.
- **ansi-escapes for the clear-screen constants in `terminalCleanup.ts`**
  and **Node's `hasColors` for `resolveStreamColor`**
  (`packages/cli/src/runtime/platform/cliContext.ts`). Six constants
  against a dependency the CLI does not declare; `hasColors` reads an
  empty `FORCE_COLOR` as on and exists only on a TTY stream.
- **update-notifier, clipboardy, electron-log, `@octokit/rest`,
  hosted-git-info.** Each spawns or stores outside Effect, lacks the case
  the code handles (Homebrew, OSC 52, images, ETag polling), or is a new
  dependency for under forty lines.
- **One `Retry-After` reader for llm and the GitHub client.** The GitHub
  client reads seconds only; #15229 deletes it.
