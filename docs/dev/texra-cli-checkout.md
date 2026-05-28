# TeXRA CLI — Checkout Workflow

Developer-only notes for running the `texra` CLI from a local repository
checkout. These instructions assume read access to the TeXRA source tree and
are not part of the public CLI guide (`docs/guide/texra-cli.md`) because the
repository is not open source.

For end-user CLI usage (`texra run`, `texra completion`, workspace defaults,
history, tools), see the [public CLI guide](../guide/texra-cli.md).

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

The linked command points to `packages/cli/dist/bin/texra.js`. Rebuild after
changing CLI code or shared runtime code:

```bash
corepack pnpm --filter @texra-ai/cli build
```

The symlink is used instead of `pnpm link --global` because the CLI package
still has workspace-only dependencies, while the built binary is self-contained.

Shell-completion dynamic lookups (`texra agents list`, `texra models list`)
reflect the current checkout. Disable them in slow shells with
`export TEXRA_COMPLETION_DYNAMIC=0` — see the public guide for the completion
install steps themselves.

## Run Without Linking

After building, the generated binary can also be run directly without the
symlink:

```bash
node packages/cli/dist/bin/texra.js --help
node packages/cli/dist/bin/texra.js agents list
node packages/cli/dist/bin/texra.js run polish --input paper.tex --output paper.polished.tex --print
```

All flags from the public guide work the same way — substitute
`node packages/cli/dist/bin/texra.js` for `texra` in any example.

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

## Remove the Linked Command

```bash
rm "$(corepack pnpm bin -g)/texra"
```
