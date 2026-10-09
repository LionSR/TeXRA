# `@texra-ai/harness/plugins` API report

Generated from `packages/harness/src/plugins.ts` by `node scripts/check-core-quality.mjs --update`; do not edit. A diff here is a change to the public surface.

Exports: 4

- `callerRun` — `const callerRun: Effect<ToolRun | undefined, never, ToolContext>`
- `harnessBuiltins` — `const harnessBuiltins: { readonly all: readonly Plugin[]; readonly minimal: readonly Plugin[]; }`
- `requireRun` — `const requireRun: (toolName: string) => Effect<ToolContextShape & { readonly run: ToolRun & { readonly requests: CallRequests; }; readonly requests: CallRequests; }, ToolError, ToolContext>`
- `ToolRun` — `type ToolRun = Pick<AgentRunShape, 'session' | 'runId' | 'toolPolicy' | 'config' | 'model' | 'delegationAgentScope' | 'steps' | 'scope' | 'task' | 'opening' | 'logger' | 'callbacks' | 'fileService'>; ≡ ToolRun`
