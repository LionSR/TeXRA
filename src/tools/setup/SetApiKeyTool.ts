// Third-party imports
import { z } from 'zod';

// Local imports
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  API_PROVIDERS,
  invalidateApiKeyCache,
  isApiProvider,
} from '@model/apiProviders';
import { ToolError, type ToolResult } from '@tools/result';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

const SetApiKeyInputSchema = z.strictObject({
  provider: z
    .string()
    .min(1)
    .describe(
      'Provider name (e.g., "openai", "anthropic", "google"). Must match a supported provider.',
    ),
  key: z
    .string()
    .min(1)
    .describe(
      'The API key, as pasted by the user. Must not be empty or a placeholder like "sk-xxx".',
    ),
});

type SetApiKeyInput = z.infer<typeof SetApiKeyInputSchema>;

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^(sk-?)?(x{3,}|\*{3,}|\.{3,}|<.*>|your[- _]?key)/i,
  /^placeholder$/i,
  /^example$/i,
];

function looksLikePlaceholder(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length < 8) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Mask the key for user-facing output. Scales the visible prefix/suffix
 * with key length so we never expose more than ~25% of the characters —
 * a 9-char key would otherwise reveal 8 of 9 under a fixed 4+4 scheme.
 * Cap at 4 on each side so long keys still show a useful fingerprint.
 */
function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
  const preview = Math.min(4, Math.floor(trimmed.length / 8));
  return `${trimmed.slice(0, preview)}…${trimmed.slice(-preview)}`;
}

/**
 * Store a user-supplied API key in SecretStorage.
 *
 * Narrow by design: one provider, one key, one write. Refuses empty /
 * placeholder values so the agent cannot accidentally commit a template
 * string. The approval surface is the SecretStorage write itself —
 * reflected back to the user via the masked summary.
 */
export class SetApiKeyTool extends defineTool({
  name: 'set_api_key',
  description: `Store a provider API key in TeXRA's secure SecretStorage. The key must be supplied by the user — this tool never generates keys. Placeholders like "sk-xxx" or "your-key" are rejected. On success, the provider appears in the "key set" list and the model options cache is refreshed. Use this only after the user has explicitly pasted a real key in the conversation.`,
  schema: SetApiKeyInputSchema,
}) {
  protected async execute(input: SetApiKeyInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const provider = input.provider.trim();

    if (!isApiProvider(provider)) {
      throw new ToolError(
        `Unknown provider "${provider}". Supported: ${API_PROVIDERS.join(', ')}.`,
      );
    }

    if (looksLikePlaceholder(input.key)) {
      throw new ToolError(
        `Refusing to store what looks like a placeholder key. Ask the user to paste their real ${provider} key.`,
      );
    }

    await platform.secrets.setApiKey(provider, input.key.trim());

    // Drop cached model availability and key-origin lookups before the refresh
    // so every downstream status surface sees the just-added key. Matches the
    // manual `texra.setApiKey` command's ordering in `apiKeyCommands`.
    invalidateModelOptionsCache();
    invalidateApiKeyCache();
    await Promise.all([
      platform.commands
        .invoke('texra.refreshApiKeyStatus')
        .catch(() => undefined),
      platform.commands
        .invoke('texra.refreshAllOptions')
        .catch(() => undefined),
    ]);

    const masked = maskKey(input.key);
    return {
      summary: `Stored ${provider} API key (${masked})`,
      output: `Stored API key for provider "${provider}" in SecretStorage as ${masked}. You can now run agents that use ${provider} models.`,
    };
  }
}
