# TeXRA CLI

The TeXRA CLI provides a local `texra` command for running TeXRA agents from a
terminal. It is currently a repository-built preview package, not a published
npm package.

## Install From a Checkout

Clone the repository, install workspace dependencies, build the CLI package, and
link it into the global pnpm bin directory:

```bash
corepack pnpm install
corepack pnpm --filter @texra/cli build
corepack pnpm --dir packages/cli link --global
```

Verify the command:

```bash
texra --help
texra version
texra agents list
```

The linked command points to `packages/cli/dist/bin/texra.js`. Rebuild after
changing CLI code or shared runtime code:

```bash
corepack pnpm --filter @texra/cli build
```

If `pnpm link --global` reports that no global binary directory is configured,
run:

```bash
corepack pnpm setup
```

Then restart the shell and repeat the link command.

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

## Remove the Linked Command

```bash
corepack pnpm --global remove @texra/cli
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
