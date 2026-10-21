# `@texra-ai/harness/node` API report

Generated from `packages/harness/src/node.ts` by `node scripts/check-core-quality.mjs --update`; do not edit. A diff here is a change to the public surface.

Exports: 26

- `absentReason` — `const absentReason: (error: PlatformError) => boolean`
- `canonicalizeWorkspacePath` — `function canonicalizeWorkspacePath: (workspacePath: string) => string`
- `ConfigStore` — `interface ConfigStore { get<T>(key: string): T | undefined; set(key: string, value: unknown): Effect.Effect<void, Error>; }`
- `createNodeWorkspaceRoots` — `function createNodeWorkspaceRoots: (init: NodeWorkspaceRootsInit) => WorkspaceRoots`
- `entryTypeIn` — `const entryTypeIn: (fs: FileSystem, target: string) => Effect<Type | undefined, PlatformError, never>`
- `envFlag` — `const envFlag: (name: string, env?: Readonly<Record<string, string | undefined>> | undefined) => Effect<boolean, never, never>`
- `executeCommand` — `const executeCommand: (command: string | string[], options: ExecuteCommandBaseOptions) => Effect<{ exitCode: number; noExitCode?: boolean | undefined; outputLimitExceeded?: boolean | undefined; stderr: string; stdout: string; success: boolean; timedOut: boolean; }, never, ChildProcessSpawner>`
- `ExecuteCommandBaseOptions` — `interface ExecuteCommandBaseOptions { readonly channel?: string; readonly env?: Record<string, string>; readonly timeout?: number; readonly cwd: string | undefined; readonly settings: SettingsStores | undefined; readonly onStdout?: (chunk: string) => void; readonly onStderr?: (chunk: string) => void; readonly buffer?: boolean; readonly maxBuffer?: number; readonly signal?: AbortSignal; readonly quiet?: boolean; readonly killProcessTree?: boolean; }`
- `findCommand` — `const findCommand: (name: string, options?: undefined | { readonly fresh?: boolean | undefined; readonly path?: string | undefined; }) => Effect<FoundCommand | null, never, ChildProcessSpawner>`
- `FoundCommand` — `interface FoundCommand { readonly command: string; readonly args: readonly string[]; readonly resolvedPath: string; }`
- `inheritedEnv` — `const inheritedEnv: (keep?: "anthropic" | "dashscope" | "deepseek" | "glm" | "google" | "kimiCode" | "meta" | "minimax" | "moonshot" | "openRouter" | "openai" | "xai" | undefined) => Effect<Record<string, string>, never, never>`
- `JsonConfigProvider` — `class JsonConfigProvider { constructor: new ({ workspace, global, local, catalog, }: JsonConfigProviderOptions) => JsonConfigProvider; static: ; instance: catalog: SettingsCatalog; get: <T>(key: string, defaultValue?: T | undefined) => T; inspect: <T = unknown>(key: string) => Partial<Record<"globalValue" | "workspaceValue", T>>; update: <T>(key: string, value: T, target?: ConfigTarget) => Effect<void, ConfigWriteFailed, never> }`
- `JsonConfigProviderOptions` — `interface JsonConfigProviderOptions { workspace: ConfigStore; global: ConfigStore; local: ConfigStore; catalog: SettingsCatalog; }`
- `nodePlatform` — `function nodePlatform: (options: NodePlatformOptions) => AgentPlatform`
- `NodePlatformOptions` — `interface NodePlatformOptions { readonly agentsDir: string; readonly workspaceDir?: string; readonly storageDir: string; readonly settings?: readonly StateSettingEntry[]; }`
- `projectValueIgnored` — `function projectValueIgnored: (catalog: SettingsCatalog, key: string, value: unknown) => boolean`
- `readDirectoryTypedTolerant` — `const readDirectoryTypedTolerant: (target: string) => Effect<(readonly [string, Type])[], PlatformError, Path>`
- `relativeToRoot` — `function relativeToRoot: (root: string, filePath: string) => string | undefined`
- `resolveGlobalStoragePath` — `function resolveGlobalStoragePath: (storageRoot: string) => string`
- `resolveWorkspaceStoragePath` — `function resolveWorkspaceStoragePath: (storageRoot: string, workspacePath: string | undefined) => string`
- `runDirUnder` — `function runDirUnder: (storageRoot: string, id: string & $brand<"RunId">) => string`
- `settingsCatalog` — `function settingsCatalog: (appRows: readonly StateSettingEntry[]) => SettingsCatalog`
- `SettingsCatalog` — `interface SettingsCatalog { readonly rows: readonly StateSettingEntry[]; readonly byKey: (key: string) => StateSettingEntry | undefined; readonly settingsViewByKey: (key: string) => SettingsViewStateSettingEntry | undefined; readonly snapshotEntries: (snapshot: SettingsViewSnapshot) => readonly SettingsViewStateSettingEntry[]; readonly cliRows: readonly SurfacedSettingEntry[]; readonly cliByKey: (key: string) => SurfacedSettingEntry | undefined; readonly configSlotKeys: readonly string[]; readonly modelsTab: (provider: string) => readonly { readonly entry: StateSettingEntry; readonly surface: ModelsTabSurface; }[]; readonly configDefault: (key: string) => unknown; }`
- `StateSettingEntry` — `interface StateSettingEntry { readonly key: string; readonly schema: z.ZodType; readonly title?: string; readonly description?: string; readonly category?: string; readonly slot: SettingStore; readonly configTarget?: 'global' | 'workspace' | 'local'; readonly projectMayOptOut?: true; readonly surfaces?: SettingSurfaces; readonly onWrite?: SettingWriteEffects; readonly enumDescriptions?: readonly string[]; readonly enumLabels?: readonly string[]; readonly openForm?: string; }`
- `withExtendedPath` — `function withExtendedPath: <T extends NodeJS.ProcessEnv>(env: T) => T`
- `writeFileAtomic` — `const writeFileAtomic: (target: string, data: Uint8Array<ArrayBufferLike>) => Effect<void, PlatformError, never>`
