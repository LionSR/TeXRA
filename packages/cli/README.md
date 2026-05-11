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

It does not yet have an honest provider-free runtime test for `texra run`.
Validation for issue #3840 must enter the real shared `executeAgent()` path.
Do not replace that requirement with a fake top-level `executeAgent` injection at
the CLI command boundary.
