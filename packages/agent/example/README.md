# Packed-tarball example

Runs [`@texra-ai/agent/effect`](../README.md#effect) the way a consumer off the
registry would: the package is packed, installed into this folder, and imported
by package name. No repository path alias appears in `effectSession.mjs`, so a
resolution the published artifact could not satisfy fails here.

It needs no provider key.

```bash
corepack pnpm --filter @texra-ai/agent run example:packed
```

which is, step by step:

```bash
# from the repository root
corepack pnpm --filter @texra-ai/agent build
cd packages/agent && rm -f example/*.tgz && corepack pnpm pack --pack-destination example
mv example/texra-ai-agent-*.tgz example/agent.tgz
cd example && npm install ./agent.tgz && npm start
```

The pack is renamed to a fixed `agent.tgz` so this folder's `package.json`
pins one filename rather than a second copy of the package version, which a
release would silently move.

`npm install` rather than `pnpm` on purpose: it installs the tarball and the two
peer dependencies (`effect`, `zod`) into a plain `node_modules`, with no
workspace link that could hide a missing export.

Expected output, with the temporary paths varying:

```text
session root: /var/folders/.../texra-agent-example-XXXX/storage/workspace-storage/texra-agent-example-XXXX-<hash>
first view level: 0 streams
sessions the owner holds: 1
[TeXRA] DEBUG [...] [agentRegistry] Scanned 0 agents from custom
[TeXRA] INFO  [...] [agentRegistry] Loaded 0 agents in 6ms
refusal: AgentNotFound - Agent "no-such-agent" was not found in the configured agent directory.
done
```

The process exits on its own: leaving the scope closed the session and disposed
the runtime that held it.
