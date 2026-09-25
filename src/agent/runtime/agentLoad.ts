import * as path from 'node:path';

import { Effect, FileSystem, Result } from 'effect';
import { getAgent } from '@agent/index';
import type { AgentEntry } from '@agent/index/agentEntry';
import {
  AgentPromptSchema,
  AgentDefinitionSchema,
  AgentSettingSchema,
  type AgentSetting,
  type AgentSettingInput,
  type AgentPrompt,
  type AgentPromptInput,
} from '@agent/core/definition/AgentDataclass';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import { loadRemoteAgent } from '@agent/remote/RemoteAgentLoader';
import { parseYamlWith, safeParseYaml } from '@common/parsing/safeParseYaml';
import { withLogChannel } from '@logger/effectLog';
import { agentKey, AgentCategory } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';

import { normalizeAgentSettingTools } from './agentSettingTools';
import type { HttpClient } from 'effect/unstable/http';

const CHANNEL = 'agentLoad';

/**
 * Parses YAML text and validates that it represents a full agent definition,
 * failing when it does not. Inheriting definitions stay partial: only a root
 * definition is held to the full settings/prompts schemas.
 */
export const validateAgentYamlContent = Effect.fn(
  'agentLoad.validateAgentYamlContent',
)(function* (content: string): Effect.fn.Return<void, Error> {
  const parsed = parseYamlWith(content, AgentDefinitionSchema);
  if (Result.isFailure(parsed)) {
    return yield* Effect.fail(
      new Error(`Failed to parse agent YAML: ${parsed.failure.message}`, {
        cause: parsed.failure,
      }),
    );
  }
  const data = parsed.success;
  if (data.inherits) return;

  const normalized = normalizeAgentSettingTools(data.settings);
  yield* logInertTools(normalized.inertToolsWarning);
  yield* Effect.try({
    try: () => {
      AgentSettingSchema.parse(normalized.settings);
      AgentPromptSchema.parse(data.prompts);
    },
    catch: ensureError,
  });
});

/** Report the load-time warning {@link normalizeAgentSettingTools} returns. */
function logInertTools(warning: string | undefined): Effect.Effect<void> {
  return warning === undefined
    ? Effect.void
    : Effect.logWarning(warning).pipe(withLogChannel(CHANNEL));
}

/** Loads and parses a YAML file from an absolute path. */
const loadYaml = Effect.fn('agentLoad.loadYaml')(function* (
  absolutePath: string,
): Effect.fn.Return<object, Error, FileSystem.FileSystem> {
  if (!path.isAbsolute(absolutePath)) {
    return yield* Effect.fail(new Error('loadYaml requires an absolute path'));
  }

  const yamlContent = yield* readNormalizedFile(
    yield* FileSystem.FileSystem,
    absolutePath,
  );
  const parsed = safeParseYaml(yamlContent);
  if (Result.isFailure(parsed)) {
    return yield* Effect.fail(
      new Error(
        `Failed to parse YAML at ${absolutePath}: ${parsed.failure.message}`,
        { cause: parsed.failure },
      ),
    );
  }
  return parsed.success as object;
});

export const loadAgentSettingAndPrompts = Effect.fn(
  'agentLoad.loadAgentSettingAndPrompts',
)(function* (
  entry: AgentEntry,
  seen: ReadonlySet<string> = new Set(),
): Effect.fn.Return<
  [AgentSetting, AgentPrompt],
  Error,
  FileSystem.FileSystem | HttpClient.HttpClient
> {
  // Handle remote agents
  if (entry.source === 'remote') {
    const remoteConfig = yield* loadRemoteAgent(entry.name);

    // Remote agents are already fully processed (tools resolved, validated)
    return [remoteConfig.settings, remoteConfig.prompts];
  }

  // Mirrors the cycle guard in agentYamlScanner.ts's inheritedDefinitionBlock:
  // a self- or mutually-referential `inherits` chain must fail loudly here
  // (this is the runtime load path) rather than recurse without bound.
  const entryKey = agentKey(entry.source, entry.name);
  if (seen.has(entryKey)) {
    return yield* Effect.fail(
      new Error(
        `Circular "inherits" chain detected: ${[...seen, entryKey].join(' -> ')}.`,
      ),
    );
  }
  const nextSeen = new Set([...seen, entryKey]);

  const rawConfig = yield* loadYaml(entry.path);
  const config = yield* Effect.try({
    try: () => AgentDefinitionSchema.parse(rawConfig),
    catch: ensureError,
  });

  // Initialize with own settings/prompts (spread creates a mutable copy).
  // Tools may still be raw name strings at this point — they are resolved below.
  let settings: AgentSettingInput = { ...config.settings };
  let prompts: AgentPromptInput = { ...config.prompts };

  // Merge with parent if inheritance is specified
  if (config.inherits) {
    const parentEntry = getAgent(agentKey(entry.source, config.inherits));
    if (!parentEntry) {
      return yield* Effect.fail(
        new Error(
          `Unable to locate parent agent "${config.inherits}" in source "${entry.source}".`,
        ),
      );
    }
    const [parentSettings, parentPrompts] = yield* loadAgentSettingAndPrompts(
      parentEntry,
      nextSeen,
    );

    // Parent provides defaults, child overrides. `AgentSetting`'s fields are a
    // structural subset of `AgentSettingInput`'s (required vs. optional), so
    // the merge can be typed as `AgentSettingInput` directly.
    settings = mergeInheritedAgentObject<AgentSettingInput>(
      parentSettings,
      settings,
    );
    prompts = mergeInheritedAgentObject(parentPrompts, prompts);
  }

  if (entry.source === 'builtInToolUse' && !settings.agentCategory) {
    settings = { ...settings, agentCategory: AgentCategory.ToolUse };
  }

  const normalized = normalizeAgentSettingTools(settings);
  yield* logInertTools(normalized.inertToolsWarning);

  // Apply defaults and validate the final settings and prompts
  return yield* Effect.try({
    try: () =>
      [
        AgentSettingSchema.parse(normalized.settings),
        AgentPromptSchema.parse(prompts),
      ] as [AgentSetting, AgentPrompt],
    catch: ensureError,
  });
});
