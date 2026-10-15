# Packed-tarball example

Runs [`@texra-ai/llm`](../../llm/README.md) and
[`@texra-ai/harness`](../README.md) the way a consumer off the registry
would: both are packed, installed into a fresh directory, type-checked and
imported by package name. No repository path alias appears in the two
programs, so a resolution the published artifacts could not satisfy fails
here.

- `llm.ts` uses `@texra-ai/llm` alone: it picks a catalog model, decides its
  route, binds it, and runs one turn against a `fetch` that answers 401, so
  the turn fails with a typed `ModelError` and nothing leaves the process.
- `effectSession.ts` composes the harness runtime, opens a session, and asks
  for an agent that does not exist, so the typed refusal is visible.

Neither needs a provider key.

```bash
corepack pnpm --filter @texra-ai/harness run example:packed
```

`scripts/example-packed.mjs` does, step by step:

1. copies this folder's `package.json`, `tsconfig.json` and programs into a
   new temporary directory outside the repository;
2. packs `@texra-ai/llm` and `@texra-ai/harness` there (each pack builds its
   package), renamed to the fixed `llm.tgz` and `harness.tgz` this folder's
   `package.json` names;
3. runs `npm install`;
4. type-checks both programs with the workspace's TypeScript: strict,
   `nodenext` resolution and `skipLibCheck` off, so every shipped declaration
   the programs reach is checked;
5. runs `npm start`, and removes the directory on success. A failing step
   keeps it and prints its path.

Outside the repository, nothing resolves by walking up into the workspace's
`node_modules`, so a dependency or a type the tarballs do not declare fails.
`npm install` rather than `pnpm`, with no lockfile: the install resolves what
a new consumer's would, peers included, so an incoherent Effect set fails
here. CI runs it (the `packed example` job) on every change to either package
or to the workspace's dependency files, and nightly.

Expected output, with the temporary paths varying:

```text
model: Sonnet 5, anthropic at https://api.anthropic.com
bound: anthropic-messages
turn failed: ModelError authentication
[...] INFO (#1): First install: plugins switched off by default:  { channel: 'toolAvailability' }
[agentRegistry] Loaded 0 agents in 4ms
session root: /var/folders/.../texra-harness-example-XXXX/storage/v1/workspace-storage/texra-harness-example-XXXX-<hash>
first view level: 0 runs
sessions the owner holds: 1
inline persona valid: true
refusal: AgentNotFound - Agent "no-such-agent" was not found in the configured agent directory.
done
```

The process exits on its own: leaving the scope closed the session and disposed
the runtime that held it.
