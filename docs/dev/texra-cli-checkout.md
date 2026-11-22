# TeXRA CLI — Checkout Workflow

This guide covers building and running the `texra` CLI from a local repository
checkout. For installed-CLI usage (`texra run`, `texra completion`, workspace
defaults, history, tools), see the [public CLI guide](../guide/texra-cli.md).

## Install From a Checkout

There are two supported paths. Pick based on whether you want the local build to
**replace** the published `texra` command or sit **alongside** it.

### Side-by-side as `texra-local` (recommended)

`texra-local:build` builds the CLI and points `~/.local/bin/texra-local` at
the launcher in this checkout. Keep `~/.local/bin` on your `PATH` to run it.

```bash
corepack pnpm install
npm run texra-local:build
texra-local
```

Re-run `texra-local:build` to refresh. To switch to an already built checkout,
run `npm run texra-local:link` there. Set `TEXRA_LOCAL_BIN_DIR` to put the link
in a different directory on `PATH`.

### Override the published `texra`

To shadow the npm-installed `texra` command with the local build, link the
bundled binary into the global pnpm bin directory:

```bash
corepack pnpm install
corepack pnpm --filter @texra-ai/cli build
corepack pnpm setup    # one-time; then restart your shell or source its rc file
PNPM_BIN="$(corepack pnpm bin -g)"
mkdir -p "$PNPM_BIN"
ln -sf "$(pwd)/packages/cli/dist/texra.js" "$PNPM_BIN/texra"
```

The linked binary takes precedence over a globally-installed npm copy, so `texra`
now runs your local build.

The linked command points to `packages/cli/dist/texra.js`. Rebuild after
changing CLI code or shared runtime code:

```bash
corepack pnpm --filter @texra-ai/cli build
```

The symlink is used instead of `pnpm link --global` because the CLI package
still has workspace-only dependencies, while the built binary is self-contained.

Shell-completion dynamic lookups (`texra models list`)
reflect the current checkout. Disable them in slow shells with
`export TEXRA_COMPLETION_DYNAMIC=0` — see the public guide for the completion
install steps themselves.

## Run Without Linking

After building, the generated binary can also be run directly without the
symlink:

```bash
node packages/cli/dist/texra.js --help
node packages/cli/dist/texra.js models list
node packages/cli/dist/texra.js run edit --input paper.tex --instruction "Polish the prose" --output paper.polished.tex --print
```

All flags from the public guide work the same way — substitute
`node packages/cli/dist/texra.js` for `texra` in any example.

## Validation

The CLI build performs type checking, architecture checks, bundling, and
resource copying:

```bash
corepack pnpm --filter @texra-ai/cli build
```

For a deterministic local run check that does not require provider credentials:

```bash
corepack pnpm --filter @texra-ai/cli validate:run
```

For deterministic TUI checks, use the Ink frame validator. It drives the CLI
through a PTY, so it verifies the same visible terminal frame a user sees in
chat mode:

```bash
corepack pnpm --filter @texra-ai/cli validate:tui
```

To capture reviewable TUI screenshots, pass a snapshot directory and the
scenario names you want to inspect. The command writes numbered `.txt` and
`.svg` frames plus an `index.html` report:

```bash
corepack pnpm --filter @texra-ai/cli validate:tui -- --snapshot-dir /tmp/texra-tui-frames \
  transcript edit-approval bash-approval-approve-session subagents
```

Open `/tmp/texra-tui-frames/index.html` in a browser to review the captured
frames.

List the available scenarios before narrowing a product-review pass:

```bash
corepack pnpm --filter @texra-ai/cli validate:tui -- --list
```

## Remove the Linked Command

For the side-by-side `texra-local` link:

```bash
rm "${TEXRA_LOCAL_BIN_DIR:-$HOME/.local/bin}/texra-local"
```

For the global `texra` override:

```bash
rm "$(corepack pnpm bin -g)/texra"
```
