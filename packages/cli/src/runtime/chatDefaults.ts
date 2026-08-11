import {
  isUserVisibleExecution,
  listExecutions,
  type ExecutionListingEntry,
} from '@agent/storage';
import { isFileNotFoundError } from '@common/errors';
import {
  decideRunModel,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
import { TEXRA_CONFIG_FILE_NAME } from '@platform/defaults/nodeStorage';
import { AgentCategory } from '@shared/schemas';
import { isImplicitDefaultEligible } from '@shared/constants/agents';
import { toNewestFirstByTimestamp } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { GlobalStorageFS } from '@utils/files/storageFS';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  commandConfigModel,
  loadWorkspaceCliConfig,
  parseCliConfigValues,
  resolveConfiguredAgent,
  resolveKnownCliModelId,
  type CliConfigValues,
} from './cliConfig';
import { pickDefaultToolUseAgent } from './defaultAgents';
import { writeTextStderr } from './logSinks';

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

export interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
  readonly source: ChatDefaultSource;
  readonly agentSource: ChatDefaultValueSource;
  readonly modelSource: ChatDefaultValueSource;
}

type ChatDefaultSource = 'workspace' | 'user' | 'history' | 'builtin' | 'mixed';

/** Chat default value sources are the shared run-model decision reasons. */
type ChatDefaultValueSource = Extract<
  RunModelDecisionReason,
  | 'explicit-override'
  | 'environment'
  | 'workspace-config'
  | 'user-config'
  | 'history'
  | 'builtin-default'
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

async function loadUserDefaults(): Promise<PartialDefaults> {
  // A missing user config means no user defaults (parseCliConfigValues maps
  // the undefined fallback to {}). Anything else — corrupt JSON, a permission
  // error — is surfaced as a warning instead of silently dropping the user's
  // chat defaults, mirroring loadWorkspaceCliConfig's handling of the same
  // class of failure for the workspace config.
  let raw: unknown;
  try {
    raw = await GlobalStorageFS.readJson(TEXRA_CONFIG_FILE_NAME);
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) {
      writeTextStderr(
        `WARN Could not read user config (${TEXRA_CONFIG_FILE_NAME}): ${toErrorMessage(error)}`,
      );
    }
    raw = undefined;
  }
  return defaultsFromConfigValues(parseCliConfigValues(raw));
}

async function loadHistoryDefaults(): Promise<PartialDefaults> {
  // An unreadable history listing means no history defaults.
  const entries: ExecutionListingEntry[] = await listExecutions().catch(
    () => [],
  );
  const candidates = toNewestFirstByTimestamp(
    entries.filter(isUserVisibleExecution).filter(
      (entry) =>
        entry.record.agentCategory === AgentCategory.ToolUse &&
        // A multi-agent team run's root is an orchestrator agent, not a
        // sensible default for a plain single-agent chat session.
        !entry.record.cliMultiAgentPresetId,
    ),
    (item) => item.timestamp,
  );
  const mostRecent = candidates[0];
  if (!mostRecent) return {};
  return { model: resolveKnownCliModelId(mostRecent.record.model) };
}

function deriveSource(sources: {
  readonly agent: ChatDefaultValueSource;
  readonly model: ChatDefaultValueSource;
}): ChatDefaultSource {
  const agentSource = chatDefaultSource(sources.agent);
  const modelSource = chatDefaultSource(sources.model);
  return agentSource === modelSource ? agentSource : 'mixed';
}

function chatDefaultSource(source: ChatDefaultValueSource): ChatDefaultSource {
  switch (source) {
    case 'workspace-config':
      return 'workspace';
    case 'user-config':
      return 'user';
    case 'history':
      return 'history';
    case 'builtin-default':
      return 'builtin';
    case 'explicit-override':
    case 'environment':
      return 'mixed';
  }
}

function sourceForOverride(
  override: string | undefined,
  env: string | undefined,
): ChatDefaultValueSource | undefined {
  if (override) return 'explicit-override';
  if (env) return 'environment';
  return undefined;
}

function buildChatDefaults(init: {
  readonly agent: string | undefined;
  readonly model: string | undefined;
  readonly agentSource: ChatDefaultValueSource | undefined;
  readonly modelSource: ChatDefaultValueSource | undefined;
  readonly visibleToolUseAgents?: readonly { readonly name: string }[];
}): ChatDefaults {
  const agentSource = init.agentSource ?? 'builtin-default';
  const modelSource = init.modelSource ?? 'builtin-default';
  return {
    agent: init.agent ?? pickDefaultToolUseAgent(init.visibleToolUseAgents),
    model: init.model ?? CLI_BUILTIN_DEFAULT_MODEL,
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
 * Four-tier lookup per `docs/prds/cli-tui-ink/2026-05-14-10-architecture.md#entrypoint-default`:
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
  let agentSource = sourceForOverride(overrideAgent, envAgent);
  const directModel = overrideModel || envModel;
  const skipDefaultTierIo = Boolean(agent && directModel);

  let workspace: PartialDefaults = {};
  let user: PartialDefaults = {};
  let history: PartialDefaults = {};

  if (!skipDefaultTierIo) {
    // Tiers are independent I/O — fan out in parallel.
    // Workspace defaults use the same .texra/config.json reader as the CLI
    // context so startup does not depend on platform initialization.
    [workspace, user, history] = await Promise.all([
      loadWorkspaceCliConfig(init.cwd).then((loaded) =>
        defaultsFromConfigValues(loaded.values),
      ),
      loadUserDefaults(),
      loadHistoryDefaults(),
    ]);
    const tiers: ReadonlyArray<
      readonly [ChatDefaultValueSource, PartialDefaults]
    > = [
      ['workspace-config', workspace],
      ['user-config', user],
      ['history', history],
    ];

    for (const [source, defaults] of tiers) {
      if (!agent && defaults.agent) {
        agent = defaults.agent;
        agentSource = source;
      }
    }
  }

  const modelDecision = decideRunModel([
    { model: overrideModel, reason: 'explicit-override' },
    { model: envModel, reason: 'environment' },
    { model: workspace.model, reason: 'workspace-config' },
    { model: user.model, reason: 'user-config' },
    { model: history.model, reason: 'history' },
    { model: CLI_BUILTIN_DEFAULT_MODEL, reason: 'builtin-default' },
  ]);

  return buildChatDefaults({
    agent,
    model: modelDecision?.model,
    agentSource,
    // The candidate list above only uses reasons in ChatDefaultValueSource.
    modelSource: modelDecision?.reason as ChatDefaultValueSource | undefined,
    visibleToolUseAgents: init.visibleToolUseAgents,
  });
}
