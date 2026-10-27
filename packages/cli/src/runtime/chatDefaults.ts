import {
  decideRunModel,
  type RunModelDecisionReason,
} from '@texra-ai/harness/host';

import { isImplicitDefaultEligible } from '@texra/shared/constants/agents';
import { CLI_CHEAP_START_MODEL, cliCommandDefaults } from './cliConfig';
import { pickDefaultToolUseAgent } from './defaultAgents';
import type { SettingsStores } from '@texra-ai/harness/host';

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
  readonly modelSource: RunModelDecisionReason;
}

interface ResolveChatDefaultsInit {
  /** The setting slots the `texra.chat` section is read from. */
  readonly stores: SettingsStores;
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
  const configured = cliCommandDefaults(init.stores, 'chat');
  const agent =
    overrideAgent || envAgent || usableConfiguredAgent(configured.agent);

  const modelDecision = decideRunModel([
    { model: overrideModel, reason: 'explicit-override' },
    { model: envModel, reason: 'environment' },
    { model: configured.model, reason: configured.modelScope ?? 'user-config' },
    { model: CLI_CHEAP_START_MODEL, reason: 'builtin-default' },
  ]);

  // The built-in default is always a candidate and every candidate is
  // runnable here, so the decision always names one.
  if (modelDecision === null)
    throw new Error('The chat model decision named no model');
  return {
    agent: agent ?? pickDefaultToolUseAgent(init.visibleToolUseAgents),
    model: modelDecision.model,
    modelSource: modelDecision.reason,
  };
}
