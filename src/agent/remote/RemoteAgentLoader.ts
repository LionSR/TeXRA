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
import { withLogChannel } from '@logger/effectLog';
import { ensureError } from '@utils/errors/errorMessage';

import { fetchRemoteAgentConfigYaml } from './remoteAgentConfigClient';
import { CHANNEL } from './remoteAgentList';
import type { RemoteAgentConfig } from './types';

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

    yield* Effect.logInfo(`Loading remote agent: ${agentName}`).pipe(
      withLogChannel(CHANNEL),
    );

    const attempt = Effect.gen(function* () {
      const configYaml = yield* fetchRemoteAgentConfigYaml(agentName, token);

      yield* Effect.logDebug(
        `Parsing YAML for remote agent: ${agentName}`,
      ).pipe(withLogChannel(CHANNEL));
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
      const normalized = normalizeAgentSettingTools(settings);
      if (normalized.inertToolsWarning !== undefined) {
        yield* Effect.logWarning(normalized.inertToolsWarning).pipe(
          withLogChannel(CHANNEL),
        );
      }
      const config = yield* Effect.try({
        try: (): RemoteAgentConfig => ({
          settings: AgentSettingSchema.parse(normalized.settings),
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

      yield* Effect.logInfo(
        `Successfully loaded remote agent: ${agentName}`,
      ).pipe(withLogChannel(CHANNEL));

      return config;
    });

    // Only the load past the auth gate logs: a signed-out caller's failure is
    // its own message, not an error-level log line.
    return yield* attempt.pipe(
      Effect.tapError((error: Error) =>
        Effect.logError(
          `Failed to load remote agent "${agentName}": ${error.message}`,
        ).pipe(withLogChannel(CHANNEL)),
      ),
    );
  },
);
