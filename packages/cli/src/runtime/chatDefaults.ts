import {
  decideRunModel,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
import { isImplicitDefaultEligible } from '@shared/constants/agents';

import { CLI_CHEAP_START_MODEL, cliCommandDefaults } from './cliConfig';
import { pickDefaultToolUseAgent } from './defaultAgents';

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

interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
  readonly modelSource: ChatDefaultValueSource;
}

/** Chat default value sources are the shared run-model decision reasons. */
type ChatDefaultValueSource = Extract<
  RunModelDecisionReason,
  | 'explicit-override'
  | 'environment'
  | 'workspace-config'
  | 'user-config'
  | 'builtin-default'
>;

interface ResolveChatDefaultsInit {
  readonly agentOverride?: string;
  readonly modelOverride?: string;
  readonly envAgent?: string;
  readonly envModel?: string;
  readonly visibleToolUseAgents?: readonly { readonly name: string }[];
}

/**
 * Four-tier lookup: `--agent`/`--model` → environment → the `texra.chat`
 * section over the top-level rows of the config provider (project
 * `.texra/config.json` over the user file, per field) → the built-in agent
 * pick and the cheap-start model.
 */
export function resolveChatDefaults(
  init: ResolveChatDefaultsInit,
): ChatDefaults {
  const overrideAgent = init.agentOverride?.trim();
  const overrideModel = init.modelOverride?.trim();
  const envAgent = usableConfiguredAgent(init.envAgent);
  const envModel = init.envModel?.trim();
  const configured = cliCommandDefaults('chat');
  const agent =
    overrideAgent || envAgent || usableConfiguredAgent(configured.agent);

  const modelDecision = decideRunModel([
    { model: overrideModel, reason: 'explicit-override' },
    { model: envModel, reason: 'environment' },
    { model: configured.model, reason: configured.modelScope ?? 'user-config' },
    { model: CLI_CHEAP_START_MODEL, reason: 'builtin-default' },
  ]);

  const model = modelDecision?.model;
  // The candidate list above only uses reasons in ChatDefaultValueSource.
  const modelSource = modelDecision?.reason as
    ChatDefaultValueSource | undefined;
  return {
    agent: agent ?? pickDefaultToolUseAgent(init.visibleToolUseAgents),
    model: model ?? CLI_CHEAP_START_MODEL,
    modelSource: modelSource ?? 'builtin-default',
  };
}
