# TeXRA CLI — Checkout Workflow

Developer-only notes for running the `texra` CLI from a local repository
checkout. These instructions assume read access to the TeXRA source tree and
are not part of the public CLI guide (`docs/guide/texra-cli.md`) because the
repository is not open source.

## Install From a Checkout

To track unreleased changes, clone the repository, install workspace
dependencies, build the CLI package, and link the bundled CLI binary into the
global pnpm bin directory:

```bash
corepack pnpm install
corepack pnpm --filter @texra-ai/cli build
corepack pnpm setup    # one-time; then restart your shell or source its rc file
PNPM_BIN="$(corepack pnpm bin -g)"
mkdir -p "$PNPM_BIN"
ln -sf "$(pwd)/packages/cli/dist/bin/texra.js" "$PNPM_BIN/texra"
```

The linked binary takes precedence over a globally-installed npm copy, so `texra`
now runs your local build.

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
corepack pnpm --filter @texra-ai/cli build
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

Pass read-only context files with repeated `--context` flags. The agent can
read these files through `{{ ALL_CONTEXTS }}`, but it should only emit revised
documents for the selected inputs:

```bash
node packages/cli/dist/bin/texra.js run firstread --input appendices.tex --context Draft0.tex --context refs.bib
```

Pass multiple inputs with repeated `--input` flags, a directory, or a glob.
Directory inputs expand recursively to `.tex` files. Multi-input runs can copy
their generated artifacts to a directory with `--output-dir`; relative document
paths are preserved under that directory:

```bash
node packages/cli/dist/bin/texra.js run firstread --input Draft0.tex --input appendices.tex --output-dir flagged
node packages/cli/dist/bin/texra.js run logic --input 'paper/**/*.tex' --output-dir logic-pass
```

Workflow agents always write generated files into the execution's run-storage
directory first. In text mode, TeXRA prints a filesystem path: the copied path
when `--output` or `--output-dir` is used, otherwise the final generated file in
run storage.

With `--output`, TeXRA also copies the final artifact to the requested
filesystem destination. JSON and NDJSON output keep `outputs[]` as the
run-storage source of truth (`relativePath`, `absolutePath`, and `location`),
include `runDirectory`, include `copiedOutput` or `copiedOutputs` when a
filesystem copy was written, and report `terminalStatus` for the completed run.

## Remove the Linked Command

```bash
rm "$(corepack pnpm bin -g)/texra"
```
