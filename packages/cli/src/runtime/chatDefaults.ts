import { TEXRA_CONFIG_FILE_NAME } from '@platform/defaults/nodeStorage';
import { listExecutions } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { decideRunModel } from '@model/runModelDecision';
import { toNewestFirstByTimestamp } from '@utils/core';
import { GlobalStorageFS } from '@utils/files/storageFS';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  commandConfigModel,
  loadWorkspaceCliConfig,
  parseCliConfigValues,
  resolveConfiguredAgent,
  type CliConfigValues,
} from './cliConfig';
import {
  isImplicitDefaultEligible,
  pickDefaultToolUseAgent,
} from './defaultAgents';
import type { CliModelSelectionSource } from './modelAccess';

/**
 * A configured or environment agent value, trimmed and dropped if it can't be
 * the implicit default — so e.g. `simplifier` set as the chat agent in config
 * is ignored rather than auto-selected. An explicit `--agent` override bypasses
 * this and is honored as-is.
 */
function usableConfiguredAgent(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isImplicitDefaultEligible(trimmed) ? trimmed : undefined;
}

export const BUILTIN_DEFAULT_CHAT_MODEL = CLI_BUILTIN_DEFAULT_MODEL;
export { BUILTIN_DEFAULT_CHAT_AGENT } from './defaultAgents';

export interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
  readonly source: ChatDefaultSource;
  readonly agentSource: ChatDefaultValueSource;
  readonly modelSource: ChatDefaultValueSource;
}

export type ChatDefaultSource =
  'workspace' | 'user' | 'history' | 'builtin' | 'mixed';

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

function defaultsFromConfigValues(values: CliConfigValues): PartialDefaults {
  return {
    agent: usableConfiguredAgent(resolveConfiguredAgent(values, 'chat')),
    model: commandConfigModel(values, 'chat'),
  };
}

async function loadWorkspaceDefaults(cwd: string): Promise<PartialDefaults> {
  const loaded = await loadWorkspaceCliConfig(cwd);
  return defaultsFromConfigValues(loaded.values);
}

async function loadUserDefaults(): Promise<PartialDefaults> {
  // A missing or corrupt user config means no user defaults:
  // parseCliConfigValues maps the undefined fallback to {}.
  const raw: unknown = await GlobalStorageFS.readJson(
    TEXRA_CONFIG_FILE_NAME,
  ).catch(() => undefined);
  return defaultsFromConfigValues(parseCliConfigValues(raw));
}

async function loadHistoryDefaults(): Promise<PartialDefaults> {
  // An unreadable history listing means no history defaults.
  const entries = await listExecutions().catch(() => []);
  const candidates = toNewestFirstByTimestamp(
    entries.filter(
      (entry) =>
        entry.agentConfig?.agentCategory === AgentCategory.ToolUse &&
        // A multi-agent team run's root is an orchestrator agent, not a
        // sensible default for a plain single-agent chat session.
        !entry.agentConfig?.cliMultiAgentPresetId,
    ),
    (item) => item.timestamp,
  );
  const mostRecent = candidates[0];
  if (!mostRecent?.agentConfig) return {};
  return {
    model: commandConfigModel(
      parseCliConfigValues({ model: mostRecent.agentConfig.model }),
      'chat',
    ),
  };
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
  readonly visibleToolUseAgents?: readonly { readonly name: string }[];
}): ChatDefaults {
  const agentSource = init.agentSource ?? 'builtin';
  const modelSource = init.modelSource ?? 'builtin';
  return {
    agent: init.agent ?? pickDefaultToolUseAgent(init.visibleToolUseAgents),
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
  readonly visibleToolUseAgents?: readonly { readonly name: string }[];
}

/**
 * Four-tier lookup per `docs/prds/cli-tui-ink/10-architecture.md#entrypoint-default`:
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
  const envAgent = usableConfiguredAgent(init.envAgent);
  const envModel = init.envModel?.trim();
  let agent = overrideAgent || envAgent;
  let model = overrideModel || envModel;
  let agentSource = sourceForOverride(overrideAgent, envAgent);
  let modelSource = sourceForOverride(overrideModel, envModel);

  if (agent && model) {
    return buildChatDefaults({
      agent,
      model,
      agentSource,
      modelSource,
      visibleToolUseAgents: init.visibleToolUseAgents,
    });
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
    if (agent && model) break;
  }

  const modelDecision = decideRunModel([
    { model: workspace.model, reason: 'workspace-config' },
    { model: user.model, reason: 'user-config' },
    { model: history.model, reason: 'history' },
    { model: BUILTIN_DEFAULT_CHAT_MODEL, reason: 'builtin-default' },
  ]);
  if (!model && modelDecision) {
    model = modelDecision.model;
    modelSource =
      modelDecision.reason === 'workspace-config'
        ? 'workspace'
        : modelDecision.reason === 'user-config'
          ? 'user'
          : modelDecision.reason === 'history'
            ? 'history'
            : 'builtin';
  }

  return buildChatDefaults({
    agent,
    model,
    agentSource,
    modelSource,
    visibleToolUseAgents: init.visibleToolUseAgents,
  });
}
