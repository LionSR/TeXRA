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
