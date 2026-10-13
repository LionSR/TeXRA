# `@texra-ai/harness/node` API report

Generated from `packages/harness/src/node.ts` by `node scripts/check-core-quality.mjs --update`; do not edit. A diff here is a change to the public surface.

Exports: 10

- `canonicalizeWorkspacePath` — `function canonicalizeWorkspacePath: (workspacePath: string) => string`
- `createNodeWorkspaceRoots` — `function createNodeWorkspaceRoots: (init: NodeWorkspaceRootsInit) => WorkspaceRoots`
- `nodePlatform` — `function nodePlatform: (options: NodePlatformOptions) => AgentPlatform`
- `NodePlatformOptions` — `interface NodePlatformOptions { readonly agentsDir: string; readonly workspaceDir?: string; readonly storageDir: string; readonly settings?: readonly StateSettingEntry[]; }`
- `relativeToRoot` — `function relativeToRoot: (root: string, filePath: string) => string | undefined`
- `resolveGlobalStoragePath` — `function resolveGlobalStoragePath: (storageRoot: string) => string`
- `resolveWorkspaceStoragePath` — `function resolveWorkspaceStoragePath: (storageRoot: string, workspacePath: string | undefined) => string`
- `settingsCatalog` — `function settingsCatalog: (appRows: readonly StateSettingEntry[]) => SettingsCatalog`
- `SettingsCatalog` — `interface SettingsCatalog { readonly rows: readonly StateSettingEntry[]; readonly byKey: (key: string) => StateSettingEntry | undefined; readonly settingsViewByKey: (key: string) => SettingsViewStateSettingEntry | undefined; readonly snapshotEntries: (snapshot: SettingsViewSnapshot) => readonly SettingsViewStateSettingEntry[]; readonly cliRows: readonly SurfacedSettingEntry[]; readonly cliByKey: (key: string) => SurfacedSettingEntry | undefined; readonly configSlotKeys: readonly string[]; readonly modelsTab: (provider: string) => readonly { readonly entry: StateSettingEntry; readonly surface: ModelsTabSurface; }[]; readonly configDefault: (key: string) => unknown; }`
- `StateSettingEntry` — `interface StateSettingEntry { readonly key: string; readonly schema: z.ZodType; readonly title?: string; readonly description?: string; readonly category?: string; readonly slot: SettingStore; readonly configTarget?: 'global' | 'workspace' | 'local'; readonly projectMayOptOut?: true; readonly surfaces?: SettingSurfaces; readonly onWrite?: SettingWriteEffects; readonly enumDescriptions?: readonly string[]; readonly enumLabels?: readonly string[]; readonly openForm?: string; }`
