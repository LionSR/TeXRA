# TeXRA CLI package

This package contains the scaffold for the standalone `texra` command.

## Package locally

Build the package-local binary:

```sh
corepack pnpm --filter @texra/cli build
```

The build writes the manifest-declared executable to:

```text
packages/cli/dist/bin/texra.js
```

The `package.json` `bin` entry maps `texra` to that generated file. The package
is still marked `private: true`, so publication is not ready yet.

## Install locally

The CLI is not published as an npm package yet. Install it from a repository
checkout:

```sh
corepack pnpm install
corepack pnpm --filter @texra/cli build
corepack pnpm setup    # one-time; ensures $PNPM_HOME/bin is on PATH
ln -sf "$(pwd)/packages/cli/dist/bin/texra.js" "$PNPM_HOME/bin/texra"
texra --help
```

This creates a global `texra` command that points to
`packages/cli/dist/bin/texra.js`. The bundle is fully self-contained (esbuild
inlines everything except `fsevents`), so the symlink is all that is needed.
Rebuild after changing CLI or shared runtime code — the symlink target stays
valid.

> `pnpm link --global` is not used here because the CLI's `package.json` lists
> `@texra/core` as a `workspace:*` dependency. pnpm refuses to resolve that spec
> when linking the package as a standalone target, so the link step fails even
> though the runtime binary does not need the dep (it is already bundled).

To remove the linked command:

```sh
rm "$PNPM_HOME/bin/texra"
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

Machine-readable output modes:

```sh
node packages/cli/dist/bin/texra.js --output-format json agents list
node packages/cli/dist/bin/texra.js --output-format ndjson agents list
node packages/cli/dist/bin/texra.js run polish --input paper.tex --output paper.polished.tex --output-format ndjson --print
```

Command-local global flags are accepted after `run`:

```sh
node packages/cli/dist/bin/texra.js run polish --input paper.tex --cwd /path/to/project --approval-policy never --print
```

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
