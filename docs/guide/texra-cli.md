# TeXRA CLI

The TeXRA CLI provides a local `texra` command for running TeXRA agents from a
terminal. It is currently a repository-built preview package, not a published
npm package.

## Install From a Checkout

Clone the repository, install workspace dependencies, build the CLI package, and
link the bundled CLI binary into the global pnpm bin directory:

```bash
corepack pnpm install
corepack pnpm --filter @texra-ai/cli build
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

## Execution History

TeXRA stores completed executions in the workspace run store. List recent runs:

```bash
texra history list
texra history list --output-format ndjson
```

Text output prints one tab-separated row per execution:

```text
<id>    <timestamp>    <agent>    <status>    <primary input>
```

The NDJSON form is stable for scripts. Each line has kind `history-entry` and
contains the same execution entry object used by JSON output.

Inspect or delete one execution:

```bash
texra history show <id>
texra history delete <id>
```

Resume a stored execution configuration headlessly:

```bash
texra resume <id>
texra --resume <id>
```

The interactive chat also accepts `/resume`. With no id it prints recent
executions; with an id it starts from the stored execution configuration. A
missing or malformed id exits with code 2 in headless commands.

## Workspace Defaults

The CLI reads optional, non-secret defaults from `.texra/config.json` in the
current workspace. Command-line flags override environment variables,
environment variables override the workspace file, and the workspace file
overrides built-in defaults.

```json
{
  "model": "deepseekT",
  "outputFormat": "text",
  "approvalPolicy": "never",
  "chat": {
    "agent": "chat",
    "model": "deepseekT"
  },
  "run": {
    "model": "deepseekT"
  }
}
```

Supported top-level keys are `agent`, `model`, `outputFormat`, and
`approvalPolicy`; `chat` and `run` may set command-specific `agent` and `model`
defaults. The built-in CLI model default is `deepseekT`.

The corresponding environment variables are `TEXRA_AGENT`, `TEXRA_MODEL`,
`TEXRA_OUTPUT_FORMAT`, `TEXRA_APPROVAL_POLICY`, and `TEXRA_API_MODE`. Run
`texra doctor` to see which workspace config file was loaded and whether any
keys were ignored.

Use `--api-mode personal` or `TEXRA_API_MODE=personal` to force a `run` or
`chat` invocation to use provider API keys even when the CLI is signed in for
included relay access. `--api-mode included` keeps the default relay behavior
when the account is signed in. The accepted aliases match the TUI `/api`
command: for example, `direct`, `api`, and `byok` select personal API keys,
while `relay` selects included access.

## Remove the Linked Command

```bash
rm "$(corepack pnpm bin -g)/texra"
```

## Validation

The CLI build performs type checking, architecture checks, bundling, and resource
copying:

```bash
corepack pnpm --filter @texra-ai/cli build
```

For a deterministic local run check that does not require provider credentials:

```bash
corepack pnpm --filter @texra-ai/cli validate:run
```
