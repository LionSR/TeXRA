/**
 * Built-in plugins (`harnessBuiltins`) and the plugin authoring surface for
 * `@texra-ai/harness`.
 *
 * > **Guide:** Read [Plugins, Tools & Codemode](/api/plugins-and-codemode) for
 * > how to author tools and plugins, how step-pinned catalogs work, and how the
 * > `script` (Codemode) sandbox replays across crashes.
 *
 * ### Key exports by role
 *
 * - **Built-in plugins**: [`harnessBuiltins`](#harnessbuiltins) bundles
 *   [`codemode`](#codemode), [`fileOps`](#fileops), [`goal`](#goal),
 *   [`memoryWorkflow`](#memoryworkflow), [`multiAgent`](#multiagent)
 *   (the `agent` tool, [`AGENT_TOOL_NAME`](#agent_tool_name), and the
 *   `program` tool), and [`web`](#web) for
 *   `Sessions.layer({ platform, plugins, client })`.
 * - **Plugin & tool authoring**: [`defineTool`](#definetool),
 *   [`definePlugin`](#defineplugin) and the
 *   [`Plugin`](#plugin) it returns (what a plugin package declares it exports),
 *   [`executed`](#executed), [`errorResult`](#errorresult),
 *   [`ToolError`](#toolerror), [`nullishWithDefault`](#nullishwithdefault),
 *   [`optionalInput`](#optionalinput),
 *   [`resolveToolPath`](#resolvetoolpath), and file-edit approval helpers
 *   ([`requestToolEditApproval`](#requesttooleditapproval),
 *   [`buildApprovalRejectedResult`](#buildapprovalrejectedresult),
 *   [`approvedWriteConflict`](#approvedwriteconflict)).
 * - **Native plugins**: an installed plugin folder's `harness.mjs` is a
 *   module whose default export ([`NativeEntryModule`](#nativeentrymodule))
 *   the harness calls with this surface and its own `effect` authoring
 *   modules ([`NativePluginHost`](#nativepluginhost)) and which returns a
 *   [`Plugin`](#plugin); once the person trusts it, it is added, replaced or
 *   removed while the process runs, each run seeing the change from its next
 *   step.
 * - **Runtime callbacks inside a tool**: the call's run and requests on
 *   [`ToolContext`](#toolcontext), [`ChildRuns`](#childruns), and
 *   [`RunInbox`](#runinbox).
 * - **Settings, stores & signals**: [`Settings`](#settings) over a
 *   [`ConfigProvider`](#configprovider) and a [`StateStore`](#statestore)
 *   (failing with [`StateReadFailed`](#statereadfailed),
 *   [`StateWriteFailed`](#statewritefailed) or
 *   [`ConfigWriteFailed`](#configwritefailed)), the rooted file systems
 *   ([`WorkspaceFs`](#workspacefs), [`StorageFs`](#storagefs),
 *   [`GlobalStorageFs`](#globalstoragefs)), and the process services a
 *   plugin layer may read ([`AppState`](#appstate),
 *   [`GlobalValues`](#globalvalues), [`ToolCatalog`](#toolcatalog),
 *   [`AppSignals`](#appsignals)).
 * - **Lifetimes, prompt sections & durable rows**:
 *   [`PromptSection`](#promptsection),
 *   [`ProcessPluginLayer`](#processpluginlayer),
 *   [`SessionPluginLayer`](#sessionpluginlayer), [`PluginHold`](#pluginhold),
 *   [`FactKind`](#factkind), and [`Program`](#program) (how its run
 *   reads: [`ProgramResult`](#programresult)).
 */
export * from '@tools/pluginSurface';
