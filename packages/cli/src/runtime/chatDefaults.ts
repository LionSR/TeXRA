import { listExecutions } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { isNonEmptyString } from '@utils/core/stringCore';
import { GlobalStorageFS } from '@utils/files/storageFS';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  isKnownCliModel,
  loadWorkspaceCliConfig,
  resolveConfiguredAgent,
  resolveConfiguredModel,
} from './cliConfig';
import type { CliModelSelectionSource } from './modelAccess';

export const BUILTIN_DEFAULT_CHAT_AGENT = 'chat';
export const BUILTIN_DEFAULT_CHAT_MODEL = CLI_BUILTIN_DEFAULT_MODEL;

export interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
  readonly source: ChatDefaultSource;
  readonly agentSource: ChatDefaultValueSource;
  readonly modelSource: ChatDefaultValueSource;
}

export type ChatDefaultSource =
  | 'workspace'
  | 'user'
  | 'history'
  | 'builtin'
  | 'mixed';

export type ChatDefaultValueSource =
  | 'override'
  | 'env'
  | Extract<
      CliModelSelectionSource,
      'workspace' | 'user' | 'history' | 'builtin'
    >;

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
    if (isKnownCliModel(model)) out.model = model;
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
    const candidates = entries
      .filter(
        (entry) =>
          entry.agentConfig?.agentCategory === AgentCategory.ToolUse &&
          // A multi-agent team run's root is an orchestrator agent, not a
          // sensible default for a plain single-agent chat session.
          !entry.agentConfig?.cliMultiAgentPresetId,
      )
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
    const mostRecent = candidates[0];
    if (!mostRecent?.agentConfig) return {};
    return pickDefaults({
      model: mostRecent.agentConfig.model,
    });
  } catch {
    return {};
  }
}

function deriveSource(sources: {
  readonly agent: ChatDefaultValueSource;
  readonly model: ChatDefaultValueSource;
}): ChatDefaultSource {
  const source = sources.agent === sources.model ? sources.agent : 'mixed';
  return source === 'override' || source === 'env' ? 'mixed' : source;
}

function sourceForOverride(
  override: string | undefined,
  env: string | undefined,
): ChatDefaultValueSource | undefined {
  if (override) return 'override';
  if (env) return 'env';
  return undefined;
}

function buildChatDefaults(init: {
  readonly agent: string | undefined;
  readonly model: string | undefined;
  readonly agentSource: ChatDefaultValueSource | undefined;
  readonly modelSource: ChatDefaultValueSource | undefined;
}): ChatDefaults {
  const agentSource = init.agentSource ?? 'builtin';
  const modelSource = init.modelSource ?? 'builtin';
  return {
    agent: init.agent ?? BUILTIN_DEFAULT_CHAT_AGENT,
    model: init.model ?? BUILTIN_DEFAULT_CHAT_MODEL,
    source: deriveSource({ agent: agentSource, model: modelSource }),
    agentSource,
    modelSource,
  };
}

export interface ResolveChatDefaultsInit {
  readonly cwd: string;
  readonly agentOverride?: string;
  readonly modelOverride?: string;
  readonly envAgent?: string;
  readonly envModel?: string;
}

/**
 * Four-tier lookup per `docs/prd/cli-tui-ink/10-architecture.md#entrypoint-default`:
 * workspace `.texra/config.json` → user `<global-storage>/config.json` →
 * last single-agent toolUse execution's model → built-in. Per-field
 * independence: a workspace that only sets `agent` still falls through to
 * user/history for `model`, but history never changes the single-chat agent.
 */
export async function resolveChatDefaults(
  init: ResolveChatDefaultsInit,
): Promise<ChatDefaults> {
  const overrideAgent = init.agentOverride?.trim();
  const overrideModel = init.modelOverride?.trim();
  const envAgent = init.envAgent?.trim();
  const envModel = init.envModel?.trim();
  let agent = overrideAgent || envAgent;
  let model = overrideModel || envModel;
  let agentSource = sourceForOverride(overrideAgent, envAgent);
  let modelSource = sourceForOverride(overrideModel, envModel);

  if (agent && model) {
    return buildChatDefaults({ agent, model, agentSource, modelSource });
  }

  // Tiers are independent I/O — fan out in parallel.
  // Workspace defaults use the same .texra/config.json reader as the CLI
  // context so startup does not depend on platform initialization.
  const [workspace, user, history] = await Promise.all([
    loadWorkspaceDefaults(init.cwd),
    loadUserDefaults(),
    loadHistoryDefaults(),
  ]);
  const tiers: ReadonlyArray<
    readonly [ChatDefaultValueSource, PartialDefaults]
  > = [
    ['workspace', workspace],
    ['user', user],
    ['history', history],
  ];

  for (const [source, defaults] of tiers) {
    if (!agent && defaults.agent) {
      agent = defaults.agent;
      agentSource = source;
    }
    if (!model && defaults.model) {
      model = defaults.model;
      modelSource = source;
    }
    if (agent && model) break;
  }

  return buildChatDefaults({ agent, model, agentSource, modelSource });
}
