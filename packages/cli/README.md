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
corepack pnpm --dir packages/cli link --global
texra --help
```

This creates a global `texra` command that points to
`packages/cli/dist/bin/texra.js`. Rebuild after changing CLI or shared runtime
code. If `pnpm link --global` reports that no global binary directory is
configured, run `corepack pnpm setup`, restart the shell, and repeat the link
step.

To remove the linked command:

```sh
corepack pnpm --global remove @texra/cli
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
