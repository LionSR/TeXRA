# TeXRA CLI

The TeXRA CLI provides a local `texra` command for running TeXRA agents from a
terminal. It is currently a repository-built preview package, not a published
npm package.

## Install From a Checkout

Clone the repository, install workspace dependencies, build the CLI package, and
link the bundled CLI binary into the global pnpm bin directory:

```bash
corepack pnpm install
corepack pnpm --filter @texra/cli build
corepack pnpm setup    # one-time; then restart your shell or source its rc file
PNPM_BIN="$(corepack pnpm bin -g)"
mkdir -p "$PNPM_BIN"
ln -sf "$(pwd)/packages/cli/dist/bin/texra.js" "$PNPM_BIN/texra"
```

Verify the command:

```bash
texra --help
texra version
texra agents list
```

## Shell Completion

TeXRA can print completion scripts for Bash, Zsh, and Fish:

```bash
texra completion bash >> ~/.bashrc
texra completion zsh > "${fpath[1]}/_texra"
texra completion fish > ~/.config/fish/completions/texra.fish
```

Restart the shell, or source the file you updated. Completion includes
subcommands, flags, enum values such as `--output-format text|json|ndjson`,
agent names for `texra run <TAB>`, and model names for `--model <TAB>`.

Agent and model completion call back into `texra agents list` and
`texra models list`, so they reflect the current checkout. Disable those
dynamic lookups in slow shells with:

```bash
export TEXRA_COMPLETION_DYNAMIC=0
```

The linked command points to `packages/cli/dist/bin/texra.js`. Rebuild after
changing CLI code or shared runtime code:

```bash
corepack pnpm --filter @texra/cli build
```

The symlink is used instead of `pnpm link --global` because the CLI package
still has workspace-only dependencies, while the built binary is self-contained.

## Run Without Linking

After building, the generated binary can also be run directly:

```bash
node packages/cli/dist/bin/texra.js --help
node packages/cli/dist/bin/texra.js agents list
```

Run a workflow agent from a project directory:

```bash
node packages/cli/dist/bin/texra.js run polish --input paper.tex --output paper.polished.tex --print
```

For workflow agents, text output prints the final generated path in run storage
such as `r1/paper.polished.tex`. If `--output` is provided, TeXRA also copies
that final artifact to the requested destination.

## Remove the Linked Command

```bash
rm "$(corepack pnpm bin -g)/texra"
```

## Validation

The CLI build performs type checking, architecture checks, bundling, and resource
copying:

```bash
corepack pnpm --filter @texra/cli build
```

For a deterministic local run check that does not require provider credentials:

```bash
corepack pnpm --filter @texra/cli validate:run
```
