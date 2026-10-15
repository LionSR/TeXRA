# Packed-tarball example

Runs [`@texra-ai/harness`](../README.md) the way a consumer off the
registry would: it and `@texra-ai/llm` are packed, installed into this folder, and imported
by package name. No repository path alias appears in `effectSession.mjs`, so a
resolution the published artifact could not satisfy fails here.

It needs no provider key.

```bash
corepack pnpm --filter @texra-ai/harness run example:packed
```

which is, step by step:

```bash
# from the repository root
corepack pnpm --filter @texra-ai/harness build
cd packages/harness && rm -f example/*.tgz
corepack pnpm --filter @texra-ai/llm pack --pack-destination "$PWD/example"
corepack pnpm pack --pack-destination example
mv example/texra-ai-harness-*.tgz example/harness.tgz
mv example/texra-ai-llm-*.tgz example/llm.tgz
cd example && npm install ./llm.tgz ./harness.tgz && npm start
```

The packs are renamed to fixed `harness.tgz` and `llm.tgz` so this folder's
`package.json` pins filenames rather than a second copy of the package
versions. The harness pack names `@texra-ai/llm` at its exact version, which
the llm tarball installed beside it satisfies.

`npm install` rather than `pnpm` on purpose: it installs the tarballs and the
peer dependencies (`effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`,
`zod`) into a plain `node_modules`, with no workspace link that could hide a
missing export, and no lockfile: the install resolves what a new consumer's
would, so an incoherent Effect set fails here. CI runs it (the
`packed example` job) on every change to either package or to the workspace's
dependency files, and nightly.

Expected output, with the temporary paths varying:

```text
[...] INFO (#1): First install: plugins switched off by default:  { channel: 'toolAvailability' }
[agentRegistry] Loaded 0 agents in 4ms
session root: /var/folders/.../texra-harness-example-XXXX/storage/v1/workspace-storage/texra-harness-example-XXXX-<hash>
first view level: 0 runs
sessions the owner holds: 1
refusal: AgentNotFound - Agent "no-such-agent" was not found in the configured agent directory.
done
```

The process exits on its own: leaving the scope closed the session and disposed
the runtime that held it.
