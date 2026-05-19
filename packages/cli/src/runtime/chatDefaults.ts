import { MODEL_CONFIGS } from 'llm-zoo';

import { listExecutions } from '@agent/storage';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { isNonEmptyString } from '@utils/core/stringCore';
import { GlobalStorageFS } from '@utils/files/storageFS';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  loadWorkspaceCliConfig,
  resolveConfiguredAgent,
  resolveConfiguredModel,
  type CliConfigValues,
} from './cliConfig';

export const BUILTIN_DEFAULT_CHAT_AGENT = 'chat';
export const BUILTIN_DEFAULT_CHAT_MODEL = CLI_BUILTIN_DEFAULT_MODEL;

export interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
  readonly source: ChatDefaultSource;
}

export type ChatDefaultSource =
  | 'workspace'
  | 'user'
  | 'history'
  | 'builtin'
  | 'mixed';

interface PartialDefaults {
  readonly agent?: string;
  readonly model?: string;
}

const CONFIG_FILE = 'config.json';

function pickDefaults(parsed: unknown): PartialDefaults {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const out: { -readonly [K in keyof PartialDefaults]: PartialDefaults[K] } =
    {};
  if (isNonEmptyString(record.agent)) out.agent = record.agent.trim();
  if (isNonEmptyString(record.model)) {
    const model = record.model.trim();
    if (MODEL_CONFIGS[model]) out.model = model;
  }
  return out;
}

async function loadWorkspaceDefaults(cwd: string): Promise<PartialDefaults> {
  const loaded = await loadWorkspaceCliConfig(cwd);
  return {
    agent: resolveConfiguredAgent(loaded.values, 'chat'),
    model: resolveConfiguredModel(loaded.values, 'chat'),
  };
}

async function loadUserDefaults(): Promise<PartialDefaults> {
  try {
    return pickDefaults(await GlobalStorageFS.readJson(CONFIG_FILE));
  } catch {
    return {};
  }
}

async function loadHistoryDefaults(): Promise<PartialDefaults> {
  try {
    const entries = await listExecutions();
    const mostRecent = entries
      .filter(
        (entry) => entry.agentConfig?.agentCategory === AgentCategory.ToolUse,
      )
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )[0];
    if (!mostRecent?.agentConfig) return {};
    return pickDefaults({
      agent: mostRecent.agentConfig.agent,
      model: mostRecent.agentConfig.model,
    });
  } catch {
    return {};
  }
}

function deriveSource(picked: {
  agent?: ChatDefaultSource;
  model?: ChatDefaultSource;
}): ChatDefaultSource {
  const sources = [picked.agent ?? 'builtin', picked.model ?? 'builtin'];
  return sources[0] === sources[1] ? sources[0] : 'mixed';
}

export interface ResolveChatDefaultsInit {
  readonly cwd: string;
  readonly agentOverride?: string;
  readonly modelOverride?: string;
  readonly envAgent?: string;
  readonly envModel?: string;
  /** @deprecated Workspace defaults are now read from the unified config provider. */
  readonly workspaceConfig?: CliConfigValues;
}

/**
 * Four-tier lookup per `docs/prd/cli-tui-ink/10-architecture.md#entrypoint-default`:
 * workspace `.texra/config.json` → user `<global-storage>/config.json` →
 * last toolUse execution → built-in. Per-field independence: a workspace that
 * only sets `agent` still falls through to user/history for `model`.
 */
export async function resolveChatDefaults(
  init: ResolveChatDefaultsInit,
): Promise<ChatDefaults> {
  const overrideAgent = init.agentOverride?.trim();
  const overrideModel = init.modelOverride?.trim();
  const envAgent = init.envAgent?.trim();
  const envModel = init.envModel?.trim();

  if (overrideAgent && overrideModel) {
    return { agent: overrideAgent, model: overrideModel, source: 'mixed' };
  }
  if ((overrideAgent || envAgent) && (overrideModel || envModel)) {
    return {
      agent: overrideAgent || envAgent || BUILTIN_DEFAULT_CHAT_AGENT,
      model: overrideModel || envModel || BUILTIN_DEFAULT_CHAT_MODEL,
      source: 'mixed',
    };
  }

  // Tiers are independent I/O — fan out in parallel.
  // Workspace defaults use the same .texra/config.json reader as the CLI
  // context so startup does not depend on platform initialization.
  const [workspace, user, history] = await Promise.all([
    init.workspaceConfig
      ? Promise.resolve({
          agent: init.workspaceConfig.chat?.agent ?? init.workspaceConfig.agent,
          model: init.workspaceConfig.chat?.model ?? init.workspaceConfig.model,
        })
      : loadWorkspaceDefaults(init.cwd),
    loadUserDefaults(),
    loadHistoryDefaults(),
  ]);
  const tiers: ReadonlyArray<readonly [ChatDefaultSource, PartialDefaults]> = [
    ['workspace', workspace],
    ['user', user],
    ['history', history],
  ];

  const pickedSources: {
    agent?: ChatDefaultSource;
    model?: ChatDefaultSource;
  } = {};
  let agent = overrideAgent || envAgent;
  let model = overrideModel || envModel;

  for (const [source, defaults] of tiers) {
    if (!agent && defaults.agent) {
      agent = defaults.agent;
      pickedSources.agent = source;
    }
    if (!model && defaults.model) {
      model = defaults.model;
      pickedSources.model = source;
    }
    if (agent && model) break;
  }

  return {
    agent: agent ?? BUILTIN_DEFAULT_CHAT_AGENT,
    model: model ?? BUILTIN_DEFAULT_CHAT_MODEL,
    source: deriveSource(pickedSources),
  };
}
