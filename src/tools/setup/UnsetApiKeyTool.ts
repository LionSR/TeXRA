// Third-party imports
import { z } from 'zod';

// Local imports
import {
  API_PROVIDERS,
  apiKeyEnvName,
  invalidateApiKeyCache,
  isApiProvider,
} from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { ToolError, type ToolResult } from '@shared/schemas';

// Local file imports
import { executed } from '@tools/core/result';
import { defineTool } from '../core/define';
import { getSetupPlatform, setupSecrets } from './platform';

const UnsetApiKeyInputSchema = z.strictObject({
  provider: z
    .string()
    .min(1)
    .describe('Provider name to remove the stored key for.'),
});

type UnsetApiKeyInput = z.infer<typeof UnsetApiKeyInputSchema>;

export class UnsetApiKeyTool extends defineTool({
  name: 'unset_api_key',
  requiresApproval: true,
  description: `Remove a provider's API key from TeXRA's persisted credential store. Use when the user wants to rotate or clear credentials. Non-destructive of any other state: just deletes that one secret. If the key is actually coming from a \`<PROVIDER>_API_KEY\` environment variable, this tool will report that: the credential store has nothing to remove, and the env var must be cleared in the user's shell.`,
  schema: UnsetApiKeyInputSchema,
}) {
  protected async execute(input: UnsetApiKeyInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const provider = input.provider.trim();
    if (!isApiProvider(provider)) {
      throw new ToolError(
        `Unknown provider "${provider}". Supported: ${API_PROVIDERS.join(', ')}.`,
      );
    }
    const envVar = apiKeyEnvName(provider);

    const storedExists = await setupSecrets.storedApiKeyExists(provider);
    if (!storedExists) {
      // If no persisted entry exists but a *usable* (non-blank) key
      // is still reported, it's coming from the `<PROVIDER>_API_KEY`
      // env var — `deleteApiKey` can't touch that, so be explicit.
      const envExists = await setupSecrets.hasUsableApiKey(provider);
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

    await setupSecrets.deleteApiKey(provider);
    // Mirror the manual `texra.setApiKey` command ordering: drop cached model
    // availability and key-origin lookups so models that just lost their
    // credential stop appearing selectable, then refresh the status surfaces.
    invalidateModelOptionsCache();
    invalidateApiKeyCache();
    if (platform.commands) {
      // Credential changes must remain successful when a host cannot refresh
      // its status surfaces; the next ordinary refresh reconciles stale UI.
      await Promise.allSettled([
        platform.commands.invoke('texra.refreshApiKeyStatus'),
        platform.commands.invoke('texra.refreshAllOptions'),
      ]);
    }

    // A shell env var can shadow the deletion — flag that so the agent can
    // tell the user why the key still appears to exist after removal.
    const stillPresent = await setupSecrets.hasUsableApiKey(provider);
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
  }
}
