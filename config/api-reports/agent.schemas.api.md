# `@texra-ai/agent/schemas` API report

Generated from `packages/agent/src/schemas.ts` by `node scripts/check-core-quality.mjs --update`; do not edit. A diff here is a change to the public surface.

Exports: 31

- `AgentCategory` — `const AgentCategory: { readonly Workflow: "workflow"; readonly ToolUse: "toolUse"; }`
- `AgentCategorySchema` — `const AgentCategorySchema: ZodEnum<{ readonly Workflow: "workflow"; readonly ToolUse: "toolUse"; }>`
- `AgentConfig` — `type AgentConfig = z.output<typeof AgentConfigSchema>;`
- `AgentConfigInput` — `type AgentConfigInput = z.input<typeof AgentConfigSharedFieldsSchema> & { agentCategory?: AgentCategory; };`
- `AgentConfigPayload` — `type AgentConfigPayload = Partial<AgentConfig> & Pick<AgentConfig, 'agent' | 'model'>;`
- `AgentConfigSchema` — `const AgentConfigSchema: ZodPreprocess<ZodDiscriminatedUnion<[ZodObject<{ editedFile: ZodPrefault<ZodNullable<ZodString>>; inputFiles: ZodPrefault<ZodArray<ZodString>>; ... 15 more ...; agentCategory: ZodLiteral<...>; }, $strip>, ZodObject<...>], "agentCategory">>`
- `AgentDefinition` — `type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;`
- `AgentDefinitionSchema` — `const AgentDefinitionSchema: ZodObject<{ name: ZodString; description: ZodOptional<ZodString>; inherits: ZodOptional<ZodString>; basedOn: ZodOptional<ZodString>; settings: ZodPrefault<...>; prompts: ZodPrefault<...>; }, $strict>`
- `AgentNameSchema` — `const AgentNameSchema: ZodString`
- `AgentPrompt` — `type AgentPrompt = z.infer<typeof AgentPromptSchema>;`
- `AgentPromptSchema` — `const AgentPromptSchema: ZodObject<{ systemPrompt: ZodPrefault<ZodString>; userPrefix: ZodPrefault<ZodString>; userRequest: ZodPrefault<ZodUnion<readonly [ZodString, ZodArray<ZodString>]>>; }, $strict>`
- `AgentSetting` — `type AgentSetting = z.infer<typeof AgentSettingSchema>;`
- `AgentSettingSchema` — `const AgentSettingSchema: ZodDiscriminatedUnion<[ZodObject<{ temperature: ZodPrefault<ZodNumber>; requiredFilesInternal: ZodPrefault<ZodRecord<ZodString, ZodString>>; ... 4 more ...; rounds: ZodPrefault<...>; }, $strict>, ZodObject<...>], "agentCategory">`
- `AgentSource` — `type AgentSource = z.infer<typeof AgentSourceSchema>;`
- `AgentSourceSchema` — `const AgentSourceSchema: ZodEnum<{ readonly CUSTOM: "custom"; readonly BUILT_IN_WORKFLOW: "builtInWorkflow"; readonly BUILT_IN_TOOL_USE: "builtInToolUse"; readonly PLUGIN: "plugin"; }>`
- `AgentToolUseSetting` — `type AgentToolUseSetting = Extract<AgentSetting, { agentCategory: typeof AgentCategory.ToolUse; }>;`
- `AgentToolUseSettingSchema` — `const AgentToolUseSettingSchema: ZodObject<{ temperature: ZodPrefault<ZodNumber>; requiredFilesInternal: ZodPrefault<ZodRecord<ZodString, ZodString>>; defaultOutputFiles: ZodPrefault<...>; tools: ZodPrefault<...>; agentCategory: ZodPrefault<...>; }, $strict>`
- `AgentWorkflowSetting` — `type AgentWorkflowSetting = Extract<AgentSetting, { agentCategory: typeof AgentCategory.Workflow; }>;`
- `AgentWorkflowSettingSchema` — `const AgentWorkflowSettingSchema: ZodObject<{ temperature: ZodPrefault<ZodNumber>; requiredFilesInternal: ZodPrefault<ZodRecord<ZodString, ZodString>>; ... 4 more ...; rounds: ZodPrefault<...>; }, $strict>`
- `RUN_OUTCOME` — `const RUN_OUTCOME: { readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }`
- `RunEndResult` — `type RunEndResult = z.infer<typeof RunEndResultSchema>;`
- `RunId` — `type RunId = z.infer<typeof RunIdSchema>;`
- `RunIdSchema` — `const RunIdSchema: $ZodBranded<ZodString, "RunId", "out">`
- `RunOutcome` — `type RunOutcome = z.infer<typeof RunOutcomeSchema>;`
- `RunOutcomeSchema` — `const RunOutcomeSchema: ZodEnum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>`
- `ToolUseAgentConfigSchema` — `const ToolUseAgentConfigSchema: ZodPreprocess<ZodObject<{ editedFile: ZodPrefault<ZodNullable<ZodString>>; inputFiles: ZodPrefault<ZodArray<ZodString>>; ... 17 more ...; backgroundScript: ZodOptional<...>; }, $strip>>`
- `ToolUseRunEndResult` — `type ToolUseRunEndResult = z.infer<typeof ToolUseRunEndResultSchema>;`
- `ToolUseRunEndResultSchema` — `const ToolUseRunEndResultSchema: ZodObject<{ outcome: ZodEnum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; usage: ZodOptional<ZodObject<{ firstInputTokens: ZodPrefault<ZodInt>; ... 7 more ...; totalToolUsePromptTokens: ZodPrefault<...>; }, $strip>>; runId: $ZodBranded<...>; memoryMisses: ZodOpti...`
- `WorkflowAgentConfigSchema` — `const WorkflowAgentConfigSchema: ZodPreprocess<ZodObject<{ editedFile: ZodPrefault<ZodNullable<ZodString>>; inputFiles: ZodPrefault<ZodArray<ZodString>>; ... 15 more ...; agentCategory: ZodLiteral<...>; }, $strip>>`
- `WorkflowRunEndResult` — `type WorkflowRunEndResult = z.infer<typeof WorkflowRunEndResultSchema>;`
- `WorkflowRunEndResultSchema` — `const WorkflowRunEndResultSchema: ZodObject<{ outcome: ZodEnum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; usage: ZodOptional<ZodObject<{ firstInputTokens: ZodPrefault<ZodInt>; ... 7 more ...; totalToolUsePromptTokens: ZodPrefault<...>; }, $strip>>; runId: $ZodBranded<...>; memoryMisses: ZodOpti...`
