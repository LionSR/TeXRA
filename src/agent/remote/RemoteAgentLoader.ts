/**
 * Config-loading half of the remote-agent client. The listing half — which the
 * agent index does reach — lives in `./remoteAgentList`.
 */
import {
  type AgentSettingInput,
  AgentPromptSchema,
  AgentSettingSchema,
  AgentDefinitionSchema,
} from '@agent/core/definition/AgentDataclass';
import { updateAgentMeta } from '@agent/index/agentRegistry';
import { extractToolNames } from '@agent/index/agentYamlScanner';
import { normalizeAgentSettingTools } from '@agent/runtime/agentSettingTools';
import { SupabaseClient } from '@auth/SupabaseClient';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { createLog } from '@logger/logUtils';
import { ensureError } from '@utils/errors/errorMessage';

import { fetchRemoteAgentConfigYaml } from './remoteAgentConfigClient';
import { CHANNEL } from './remoteAgentList';
import type { RemoteAgentConfig } from './types';

const log = createLog(CHANNEL);

/** Load a remote agent configuration by name. */
export async function loadRemoteAgent(
  agentName: string,
): Promise<RemoteAgentConfig> {
  if (!(await SupabaseClient.isAuthenticated())) {
    throw new Error(
      'Remote agents require authentication. Sign in using the "TeXRA: Sign In" command.',
    );
  }

  log.info(`Loading remote agent: ${agentName}`);

  try {
    const token = await SupabaseClient.getAccessToken();
    if (!token) {
      throw new Error(
        'Authentication token unavailable. Try signing in again.',
      );
    }

    const configYaml = await fetchRemoteAgentConfigYaml(agentName, token);

    log.debug(`Parsing YAML for remote agent: ${agentName}`);
    const parsedYaml = parseYamlWith(configYaml, AgentDefinitionSchema);
    if (parsedYaml.isErr()) {
      throw new Error(
        `Failed to parse YAML for remote agent "${agentName}": ${parsedYaml.error.message}`,
        { cause: parsedYaml.error },
      );
    }
    const validated = parsedYaml.value;

    const settings: AgentSettingInput = validated.settings;
    const toolNames = extractToolNames(settings.tools);
    const defaultOutputFiles = settings.defaultOutputFiles;

    const config: RemoteAgentConfig = {
      settings: AgentSettingSchema.parse(
        normalizeAgentSettingTools(settings, CHANNEL),
      ),
      prompts: AgentPromptSchema.parse(validated.prompts),
    };

    updateAgentMeta(`remote:${agentName}`, {
      description: validated.description,
      tools: toolNames?.length ? toolNames : undefined,
      defaultOutputFiles: defaultOutputFiles?.length
        ? defaultOutputFiles
        : undefined,
    });

    log.info(`Successfully loaded remote agent: ${agentName}`);

    return config;
  } catch (error) {
    const lastError = ensureError(error);
    log.error(
      `Failed to load remote agent "${agentName}": ${lastError.message}`,
    );
    throw lastError;
  }
}
