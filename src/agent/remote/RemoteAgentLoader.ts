/**
 * Config-loading half of the remote-agent client. Resolving a remote agent's
 * YAML tool list pulls in `@tools/registry` (through
 * `resolveAgentSettingTools`), which imports every registered tool; keep this
 * module out of any path reachable from `src/tools/`. The listing half — which
 * the agent index does reach — lives in `./remoteAgentList`.
 */
import {
  type AgentSettingInput,
  AgentPromptSchema,
  AgentSettingSchema,
  AgentDefinitionSchema,
} from '@agent/core/definition/AgentDataclass';
import { updateAgentMeta } from '@agent/index/agentRegistry';
import { extractToolNames } from '@agent/index/agentYamlScanner';
import { resolveAgentSettingTools } from '@agent/runtime/agentSettingTools';
import { SupabaseClient } from '@auth/SupabaseClient';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import * as logger from '@logger/logUtils';
import { ensureError } from '@utils/errors/errorMessage';

import { fetchRemoteAgentConfigYaml } from './remoteAgentConfigClient';
import { CHANNEL } from './remoteAgentList';
import type { RemoteAgentConfig } from './types';

/** Load a remote agent configuration by name. */
export async function loadRemoteAgent(
  agentName: string,
): Promise<RemoteAgentConfig> {
  if (!(await SupabaseClient.isAuthenticated())) {
    throw new Error(
      'Remote agents require authentication. Sign in using the "TeXRA: Sign In" command.',
    );
  }

  logger.info(CHANNEL, `Loading remote agent: ${agentName}`);

  try {
    const token = await SupabaseClient.getAccessToken();
    if (!token) {
      throw new Error(
        'Authentication token unavailable. Try signing in again.',
      );
    }

    const configYaml = await fetchRemoteAgentConfigYaml(agentName, token);

    logger.debug(CHANNEL, `Parsing YAML for remote agent: ${agentName}`);
    const parsedYaml = parseYamlWith(configYaml, AgentDefinitionSchema);
    if (parsedYaml.isErr()) {
      throw new Error(
        `Failed to parse YAML for remote agent "${agentName}": ${parsedYaml.error.message}`,
        { cause: parsedYaml.error },
      );
    }
    const validated = parsedYaml.value;

    // Extract metadata before resolving tools to full definitions (for registry cache)
    const settings: AgentSettingInput = validated.settings;
    const toolNames = extractToolNames(settings.tools);
    const defaultOutputFiles = settings.defaultOutputFiles;

    // Process tool definitions (remote agents are self-contained)
    const resolvedSettings = resolveAgentSettingTools(settings, CHANNEL);

    const config: RemoteAgentConfig = {
      settings: AgentSettingSchema.parse(resolvedSettings),
      prompts: AgentPromptSchema.parse(validated.prompts),
    };

    updateAgentMeta(`remote:${agentName}`, {
      description: validated.description,
      tools: toolNames?.length ? toolNames : undefined,
      defaultOutputFiles: defaultOutputFiles?.length
        ? defaultOutputFiles
        : undefined,
    });

    logger.info(CHANNEL, `Successfully loaded remote agent: ${agentName}`);

    return config;
  } catch (error) {
    const lastError = ensureError(error);
    logger.error(
      CHANNEL,
      `Failed to load remote agent "${agentName}": ${lastError.message}`,
    );
    throw lastError;
  }
}
