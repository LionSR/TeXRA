// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import {
  API_PROVIDERS,
  apiKeySecretName,
  hasUsableApiKey,
  isApiProvider,
} from '@model/apiProviders';
import { Secrets } from '@platform/secrets';
import { apiKeyEnvName } from '@shared/constants/providers';
import { ToolError } from '@shared/schemas';

// Local file imports
import { executed } from '@tools/core/result';
import { defineTool } from '../core/define';

const UnsetApiKeyInputSchema = z.strictObject({
  provider: z
    .string()
    .min(1)
    .describe('Provider name to remove the stored key for.'),
});

type UnsetApiKeyInput = z.infer<typeof UnsetApiKeyInputSchema>;

const unsetApiKey = Effect.fn('UnsetApiKeyTool.execute')(function* (
  input: UnsetApiKeyInput,
) {
  const secrets = yield* Secrets;
  const provider = input.provider.trim();
  if (!isApiProvider(provider)) {
    return yield* Effect.fail(
      new ToolError(
        `Unknown provider "${provider}". Supported: ${API_PROVIDERS.join(', ')}.`,
      ),
    );
  }
  const envVar = apiKeyEnvName(provider);

  // Only a persisted entry counts here: an environment-backed key is
  // reported below instead, since `delete` cannot touch it.
  const storedKeys = yield* secrets.listStoredKeys();
  if (!storedKeys.includes(apiKeySecretName(provider))) {
    // If no persisted entry exists but a *usable* (non-blank) key
    // is still reported, it's coming from the `<PROVIDER>_API_KEY`
    // env var — `deleteApiKey` can't touch that, so be explicit.
    const envExists = yield* hasUsableApiKey(secrets, provider);
    if (envExists) {
      return executed(
        `No stored API key for "${provider}" to remove, but one is still active via the ${envVar} environment variable. The credential store has nothing to clear: unset ${envVar} in your shell (or the source that sets it) to remove this credential.`,
        `${provider} key is env-var-backed`,
      );
    }
    return executed(
      `There was no stored API key for provider "${provider}" to remove.`,
      `No stored ${provider} API key`,
    );
  }

  // The store drops the key cache and announces the change itself, so every
  // host's credential surfaces repaint from its `credentialChanged` signal.
  yield* secrets.delete(apiKeySecretName(provider));

  // A shell env var can shadow the deletion — flag that so the agent can
  // tell the user why the key still appears to exist after removal.
  const stillPresent = yield* hasUsableApiKey(secrets, provider);
  if (stillPresent) {
    return executed(
      `Removed stored API key for provider "${provider}", but the ${envVar} environment variable is still set and will continue to provide a credential. Unset ${envVar} in your shell to fully remove it.`,
      `Removed stored ${provider} key (env var still active)`,
    );
  }

  return executed(
    `Removed stored API key for provider "${provider}".`,
    `Removed ${provider} API key`,
  );
});

export const UnsetApiKeyTool = defineTool({
  name: 'unset_api_key',
  requiresApproval: true,
  description: `Remove a provider's API key from TeXRA's persisted credential store. Use when the user wants to rotate or clear credentials. Non-destructive of any other state: just deletes that one secret. If the key is actually coming from a \`<PROVIDER>_API_KEY\` environment variable, this tool will report that: the credential store has nothing to remove, and the env var must be cleared in the user's shell.`,
  schema: UnsetApiKeyInputSchema,
  execute: unsetApiKey,
});
