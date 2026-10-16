# `@agent/runtime` API report

Generated from `packages/harness/src/agent/runtime/index.ts` by `node scripts/check-core-quality.mjs --update`; do not edit. The hosts' one internal door, not SDK surface: its names only shrink.

Exports: 2

- `runRefusal` — `const runRefusal: (runId: string & $brand<"RunId">, session: SessionHandle) => Effect<RunRefusal | null, Error, never>`
- `SessionHandle` — `interface SessionHandle { readonly roots: WorkspaceRoots; readonly log: SessionLog; readonly view: SessionViewAccess; readonly runs: RunsShape; readonly tools: SessionTools; readonly requests: SessionRequests; readonly approvals: SessionApprovals; readonly interactions: SessionHostInteractions; readonly followUps: Inbox; readonly trace: RunTrace; readonly runHistory: Context.Service.Shape<typeof RunHistory>; readonly history: HistoryQuery; }`
