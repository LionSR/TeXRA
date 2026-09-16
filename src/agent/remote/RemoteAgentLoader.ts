/**
 * Config-loading half of the remote-agent client. The listing half — which the
 * agent index does reach — lives in `./remoteAgentList`.
 */
import { Effect, Result } from 'effect';
import {
  type AgentSettingInput,
  AgentPromptSchema,
  AgentSettingSchema,
  AgentDefinitionSchema,
} from '@agent/core/definition/AgentDataclass';
import { updateAgentMeta } from '@agent/index/agentRegistry';
import { extractToolNames } from '@agent/index/agentYamlScanner';
import { normalizeAgentSettingTools } from '@agent/runtime/agentSettingTools';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { createLog } from '@logger/logUtils';
import { ensureError } from '@utils/errors/errorMessage';

import { fetchRemoteAgentConfigYaml } from './remoteAgentConfigClient';
import { CHANNEL } from './remoteAgentList';
import type { RemoteAgentConfig } from './types';

const log = createLog(CHANNEL);

/**
 * Load a remote agent configuration by name. A composition with no account
 * plane (the embeddable agent package) answers the same as a signed-out user:
 * the authentication-required failure.
 */
export const loadRemoteAgent = Effect.fn('RemoteAgentLoader.loadRemoteAgent')(
  function* (agentName: string): Effect.fn.Return<RemoteAgentConfig, Error> {
    const auth = yield* Effect.serviceOption(SupabaseAuth);
    const token = auth._tag === 'Some' ? yield* auth.value.accessToken : null;
    if (!token) {
      return yield* Effect.fail(
        new Error(
          'Remote agents require authentication. Sign in using the "TeXRA: Sign In" command.',
        ),
      );
    }

    log.info(`Loading remote agent: ${agentName}`);

    const attempt = Effect.gen(function* () {
      const configYaml = yield* Effect.tryPromise({
        try: () => fetchRemoteAgentConfigYaml(agentName, token),
        catch: ensureError,
      });

      log.debug(`Parsing YAML for remote agent: ${agentName}`);
      const parsedYaml = parseYamlWith(configYaml, AgentDefinitionSchema);
      if (Result.isFailure(parsedYaml)) {
        return yield* Effect.fail(
          new Error(
            `Failed to parse YAML for remote agent "${agentName}": ${parsedYaml.failure.message}`,
            { cause: parsedYaml.failure },
          ),
        );
      }
      const validated = parsedYaml.success;

      const settings: AgentSettingInput = validated.settings;
      const toolNames = extractToolNames(settings.tools);
      const defaultOutputFiles = settings.defaultOutputFiles;

      // The stricter setting/prompt schemas throw: keep that on the typed
      // channel, where the tapError below logs it, as the old try/catch did —
      // a defect would skip the log.
      const config = yield* Effect.try({
        try: (): RemoteAgentConfig => ({
          settings: AgentSettingSchema.parse(
            normalizeAgentSettingTools(settings, CHANNEL),
          ),
          prompts: AgentPromptSchema.parse(validated.prompts),
        }),
        catch: ensureError,
      });

      updateAgentMeta(`remote:${agentName}`, {
        description: validated.description,
        tools: toolNames?.length ? toolNames : undefined,
        defaultOutputFiles: defaultOutputFiles?.length
          ? defaultOutputFiles
          : undefined,
      });

      log.info(`Successfully loaded remote agent: ${agentName}`);

      return config;
    });

    // Only the load past the auth gate logs: a signed-out caller's failure is
    // its own message, not an error-level log line.
    return yield* attempt.pipe(
      Effect.tapError((error: Error) =>
        Effect.sync(() => {
          log.error(
            `Failed to load remote agent "${agentName}": ${error.message}`,
          );
        }),
      ),
    );
  },
);
