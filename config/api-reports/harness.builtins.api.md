# `@texra-ai/harness/builtins` API report

Generated from `packages/harness/src/builtins.ts` by `npm run docgen`; do not edit. A diff here is a change to the public surface.

Exports: 9

- `AGENT_TOOL_NAME` — `const AGENT_TOOL_NAME: "agent"`
- `codemode` — `const codemode: Plugin`
- `fileOps` — `const fileOps: (options?: { readonly writeFilter?: WriteFilter | undefined; }) => Plugin`
- `goal` — `const goal: Plugin`
- `harnessBuiltins` — `const harnessBuiltins: readonly Plugin[]`
- `memoryWorkflow` — `const memoryWorkflow: Plugin`
- `multiAgent` — `const multiAgent: Plugin`
- `web` — `const web: Plugin`
- `WriteFilter` — `type WriteFilter = (path: string, content: string, config: ConfigProvider) => Effect.Effect<string>; ≡ WriteFilter`
