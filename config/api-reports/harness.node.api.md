# `@texra-ai/harness/node` API report

Generated from `packages/harness/src/node.ts` by `node scripts/check-core-quality.mjs --update`; do not edit. A diff here is a change to the public surface.

Exports: 7

- `canonicalizeWorkspacePath` — `function canonicalizeWorkspacePath: (workspacePath: string) => string`
- `createNodeWorkspaceRoots` — `function createNodeWorkspaceRoots: (init: NodeWorkspaceRootsInit) => WorkspaceRoots`
- `nodePlatform` — `function nodePlatform: (options: NodePlatformOptions) => AgentPlatform`
- `NodePlatformOptions` — `interface NodePlatformOptions { readonly agentsDir: string; readonly workspaceDir?: string; readonly storageDir: string; }`
- `relativeToRoot` — `function relativeToRoot: (root: string, filePath: string) => string | undefined`
- `resolveGlobalStoragePath` — `function resolveGlobalStoragePath: (storageRoot: string) => string`
- `resolveWorkspaceStoragePath` — `function resolveWorkspaceStoragePath: (storageRoot: string, workspacePath: string | undefined) => string`
