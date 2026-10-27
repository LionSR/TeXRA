# Packed-tarball examples

Runs [`@texra-ai/llm`](../../llm/README.md) and [`@texra-ai/harness`](../README.md) the way a consumer off the registry gets them: both packages are packed into `.tgz` tarballs, installed into a fresh directory outside the repository with `npm install`, type-checked with `skipLibCheck: false`, and executed by `node`. Every import specifier is a published package subpath (`@texra-ai/llm`, `@texra-ai/llm/node`, `@texra-ai/harness`, `@texra-ai/harness/node`, `@texra-ai/harness/plugins`, `@texra-ai/harness/schemas`, `@texra-ai/harness/transcript`), never a workspace path alias.

None of the examples need a provider API key or network access: `01-llm-turn.ts` supplies in-process `fetch` handlers, and `02`–`06` use `_support.ts`, which wires `nodePlatform` with an in-memory Anthropic Messages SSE dispatcher.

```bash
corepack pnpm --filter @texra-ai/harness run example:packed
```

## Examples ladder

| File                             | What it exercises                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-llm-turn.ts`                 | `@texra-ai/llm` standalone: `selectModel`, `decideModelRoute`, `resolveRouteEndpoint`, `bindModel`, `prepareTurn`, `streamTurn` (over synthetic SSE), `turnCost`, and a 401 `ModelError`. |
| `02-session-and-events.ts`       | `Sessions.layer({ platform, plugins: harnessBuiltins })`, `sessions.open`, `InlinePersonaSchema`, `AgentNotFound` refusal, `run.events` through `responseText`, and `run.result`.         |
| `03-custom-tools-and-plugins.ts` | `defineTool` (`nullishWithDefault`, `lane: 'parallel'`, `replay: 'safe'`, `executed`), `definePlugin`, and a two-turn tool call loop.                                                     |
| `04-approvals-and-requests.ts`   | Approval-gated tool (`requiresApproval: true`), `session.attach({ approve })`, interactive `waiting` state, `session.request({ kind: 'followUp.send' })`, and `run.stop`.                 |
| `05-durable-resume-and-fork.ts`  | Persistent SQLite store (`{ persistent: true }`), `session.request({ kind: 'run.fork' })`, resuming the forked branch via `followUp.send`, `listRuns()`, and `records()`.                 |
| `06-views-and-transcript.ts`     | `session.view.subscribe`, `sessionActivity`, `attentionOf`, `acceptsFollowUp`, `TranscriptRow` formatting (`rowHeadline`, `elideText`), and `ToolRowModel` sections.                      |

## How `scripts/example-packed.mjs` runs

1. Copies `package.json`, `tsconfig.json`, `_support.ts`, and `01-*.ts`..`06-*.ts` into a temporary directory outside the repository.
2. Runs `pnpm --filter @texra-ai/llm pack` and `pnpm --filter @texra-ai/harness pack` into that directory as `llm.tgz` and `harness.tgz`.
3. Runs `npm install --no-audit --no-fund` (plain `node_modules`, no workspace lockfile).
4. Runs `tsc -p` with `strict: true`, `moduleResolution: "nodenext"`, and `skipLibCheck: false`.
5. Runs `npm start` (executing `01` through `06` in order) and removes the temporary directory on success.
