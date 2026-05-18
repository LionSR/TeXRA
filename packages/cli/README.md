# TeXRA CLI

This package provides the standalone `texra` command.

## Install from npm

```sh
npm install -g @texra/cli
texra --help
```

The published command is a self-contained esbuild bundle. Runtime libraries are
inlined into `dist/bin/texra.js`, so npm only needs to install the generated
binary and packaged resources.

## Package locally

Build the package-local binary:

```sh
corepack pnpm --filter @texra/cli build
```

The build writes the manifest-declared executable to:

```text
packages/cli/dist/bin/texra.js
```

The `package.json` `bin` entry maps `texra` to that generated file. Packaging
runs the build through `prepack`, so `npm pack` and `npm publish` rebuild the
binary before producing a tarball.

## Install locally from a checkout

```sh
corepack pnpm install
corepack pnpm --filter @texra/cli build
corepack pnpm setup    # one-time; then restart your shell or source its rc file
PNPM_BIN="$(corepack pnpm bin -g)"
mkdir -p "$PNPM_BIN"
ln -sf "$(pwd)/packages/cli/dist/bin/texra.js" "$PNPM_BIN/texra"
texra --help
```

This creates a global `texra` command that points to
`packages/cli/dist/bin/texra.js`. The bundle is fully self-contained (esbuild
inlines everything except `fsevents`), so the symlink is all that is needed.
Rebuild after changing CLI or shared runtime code — the symlink target stays
valid.

> `pnpm link --global` is not used here because package-manager link commands
> can expose workspace dependencies differently from the published bundle. The
> generated binary is the published artifact, so the symlink points directly at
> that file.

To remove the linked command:

```sh
rm "$(corepack pnpm bin -g)/texra"
```

## Run locally

After building, execute the generated binary directly:

```sh
node packages/cli/dist/bin/texra.js --help
node packages/cli/dist/bin/texra.js version
node packages/cli/dist/bin/texra.js agents list
```

Run a workflow agent:

```sh
node packages/cli/dist/bin/texra.js run polish --input paper.tex --output paper.polished.tex --print
```

Pass read-only context files with repeated `--context` flags. The agent reads
these through `{{ ALL_CONTEXTS }}` while writing outputs only for the selected
inputs:

```sh
node packages/cli/dist/bin/texra.js run firstread --input appendices.tex --context Draft0.tex --context refs.bib
```

Pass multiple inputs with repeated `--input` flags, a directory, or a glob.
Directory inputs expand recursively to `.tex` files. Multi-input runs can copy
their generated artifacts to a directory with `--output-dir`; relative document
paths are preserved under that directory:

```sh
node packages/cli/dist/bin/texra.js run firstread --input Draft0.tex --input appendices.tex --output-dir flagged
node packages/cli/dist/bin/texra.js run logic --input 'paper/**/*.tex' --output-dir logic-pass
```

For workflow agents, text output prints the final generated path in run storage
such as `r1/paper.polished.tex`. If `--output` is provided, TeXRA also copies
that final artifact to the requested destination.

Machine-readable output modes:

```sh
node packages/cli/dist/bin/texra.js --output-format json agents list
node packages/cli/dist/bin/texra.js --output-format ndjson agents list
node packages/cli/dist/bin/texra.js run polish --input paper.tex --output paper.polished.tex --output-format ndjson --print
```

Inspect stored executions:

```sh
node packages/cli/dist/bin/texra.js history list
node packages/cli/dist/bin/texra.js history list --output-format ndjson
node packages/cli/dist/bin/texra.js history show <id>
node packages/cli/dist/bin/texra.js resume <id>
```

`history list --output-format ndjson` emits stable `history-entry` records for
scripts. `resume <id>` runs the stored execution configuration again and exits
with code 2 when the id is malformed or not found. In `texra chat`, `/resume`
lists recent executions and `/resume <id>` starts from the stored configuration.

Command-local global flags are accepted after `run`:

```sh
node packages/cli/dist/bin/texra.js run polish --input paper.tex --cwd /path/to/project --approval-policy never --print
```

## Workspace defaults

Place optional defaults in `.texra/config.json`:

```json
{
  "model": "deepseekT",
  "outputFormat": "text",
  "approvalPolicy": "never",
  "chat": { "agent": "chat", "model": "deepseekT" },
  "run": { "model": "deepseekT" }
}
```

Flags override environment variables, environment variables override this file,
and the file overrides built-in defaults. The supported environment variables
are `TEXRA_AGENT`, `TEXRA_MODEL`, `TEXRA_OUTPUT_FORMAT`, and
`TEXRA_APPROVAL_POLICY`.

## Current validation status

The CLI package currently has structural gates:

- `typecheck`
- `check:architecture`
- `build`
- `validate:run`

The `validate:run` script builds the package, executes the generated binary, and
uses an internal validation model handler below `executeAgent()`. This is
deliberately not a user-facing model or CLI flag: the CLI command still calls the
real shared runtime, while the model layer supplies deterministic text so the
test does not require provider credentials.
