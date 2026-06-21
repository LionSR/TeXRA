---
created: 2026-05-21
updated: 2026-05-21
---

# 25 · Attachments And File Mentions

## 25. Attachments And File Mentions

### Summary

This note fixes the Phase 5 design for image attachments and `@` file
mentions in the CLI TUI. The terminal cannot provide the same browser
clipboard and drag/drop surface as the extension webview, so the CLI should
match the extension's semantic model rather than its exact DOM events:

- images become named attachments, represented in the draft by stable
  `[Image #N]` tokens;
- workspace files become relative references, inserted by an `@` picker;
- both surfaces feed the same message-building path used by ordinary file and
  media inputs.

Inline terminal image rendering remains out of scope for v1. The TUI should be
usable in plain xterm-compatible terminals, tmux, SSH sessions, and CI logs.

### Image Attachments

#### Detection

Do not rely on bracketed paste to deliver image bytes. Bracketed paste is useful
for multi-line text, but most terminals do not forward binary clipboard data to
the process. Kitty graphics, iTerm2 OSC 1337, WezTerm image support, and Sixel
are display protocols, not a portable paste protocol.

The v1 detection path should therefore have two explicit entry points:

1. **Paste-time clipboard probe.** When `BaseTextInput` receives a paste event,
   keep the current text behavior and also ask a host clipboard adapter whether
   an image is present. If the adapter returns bytes, store them as an
   attachment and insert a token. If it returns nothing, treat the paste as text
   only.
2. **Command palette attach action.** Add a palette row such as
   `Attach image from clipboard`. This gives users a deterministic fallback
   when their terminal sends no image signal during paste.

Platform support should be adapter-based. On macOS this can shell out to
`pngpaste` when available, with a clear missing-tool message. Linux and Windows
can start as unsupported adapters that report the limitation without breaking
text paste.

#### Rendering

Render attachments as text tokens only:

```text
[Image #1]
[Image #2]
```

Do not opportunistically render Kitty, iTerm2, or Sixel previews in v1. Those
protocols have different lifetime, sizing, and multiplexer behavior; adding
them before the token path is stable would complicate the core interaction.
The palette may show metadata such as file name, MIME type, dimensions when
known, and byte size.

#### Storage

Store pasted image bytes on disk under the current execution or chat run
storage directory:

```text
<run-storage>/attachments/pasted_<timestamp>_<id>.<ext>
```

The in-memory TUI state should hold only an index:

```ts
interface CliAttachmentRef {
  id: string; // "Image #1"
  path: string;
  mediaType: string;
  displayName: string;
  createdAt: string;
}
```

This mirrors the extension's behavior of turning pasted images into named files
instead of leaving them as transient clipboard objects. It also makes transcript
resume, debugging, and model-handler conversion possible without keeping binary
data in React state.

#### Send-Time Expansion

At submit time, parse `[Image #N]` tokens in the draft. For each token:

- look up the corresponding `CliAttachmentRef`;
- read bytes from disk;
- pass a typed image part to handlers that support vision;
- leave a textual note for handlers that do not support image input.

Missing attachment files should fail the submit before a model call starts. A
stale token is an input error, not a recoverable model-side condition.

#### Headless Behavior

Headless workflows should not depend on clipboard state. Keep image input
explicit:

- existing `texra run --input <image-file>` paths remain file based;
- future `texra chat --attach <image-file>` or `texra run --attach <image-file>`
  may share the same attachment conversion path;
- `--output-format ndjson` should report attachment metadata, not inline bytes.

### `@` File Mentions

#### Index Source

Build a workspace file index from `platform().workspace.getWorkspacePath()` at
TUI mount. Use `fast-glob` for v1, as already recorded in the architecture
notes. The index should produce normalized workspace-relative POSIX paths so
the inserted mention is stable across hosts:

```text
@paper/sections/introduction.tex
```

The file picker and command palette must share this one index. A keypress
should never trigger a fresh workspace scan.

#### Ignore Rules

Default rules:

- respect `.gitignore`;
- exclude `.git/`, `node_modules/`, common build directories, and TeX auxiliary
  output;
- hide dotfiles unless the query itself starts with `.`.

The palette can later add an "include hidden" toggle, but v1 should optimize
for the files a user would reasonably attach to a research conversation.

#### Large Workspaces

The indexer should run asynchronously and publish partial state:

1. start with recently opened or recently selected files if available;
2. scan the workspace in the background;
3. cap the initial index, for example at 50,000 files;
4. show a compact notice when the cap is reached and the query may be partial.

Search should use a precomputed lowercase key and path segments, then rank by
basename prefix, path prefix, and fuzzy score. This is sufficient for large
paper repositories and avoids a full fuzzy pass over every file on each
keystroke.

#### Picker UX

Use two surfaces backed by the same index:

- **Inline `@` dropdown.** Opens under the input line when the draft contains an
  active `@query`. Arrow keys move the selection; Enter inserts the focused
  path; Escape closes the dropdown without changing the draft.
- **Ctrl-P files section.** Shows the same candidates in the command palette's
  `files` section. Selecting a row inserts the `@relative/path` token.

Mentions are textual until submit. At submit time the parser resolves each
mention against the workspace root and rejects paths outside the workspace.

### Implementation Slices

1. Add a workspace file indexer and shared file-candidate ranking. Ship it with
   the Ctrl-P files section first.
2. Add inline `@` detection in `InputBar`/`BaseTextInput` using the same
   candidate source.
3. Add the attachment store and token parser with file-based `--attach` tests.
4. Add paste-time clipboard probing behind per-platform adapters.
5. Add the command-palette clipboard attach action.

These slices are independently testable. The first two do not require any
model-handler changes; the attachment slices should land with model-handler
conversion tests for at least one vision-capable provider and one
non-vision-capable provider.
