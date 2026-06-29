// Third-party imports
import { z } from 'zod';

// Local imports
import { apiKeySecretName } from '@model/apiProviders';
import { type ToolResult } from '@shared/schemas/toolResult';
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

const ListApiKeysInputSchema = z
  .strictObject({})
  .describe(
    'No inputs — audits secret key names stored in TeXRA SecretStorage.',
  );

type ListApiKeysInput = z.infer<typeof ListApiKeysInputSchema>;

/**
 * Audit secret key *names* in SecretStorage (values are never read).
 *
 * Uses `SecretStorage.keys()` (stable since VS Code 1.105). The result
 * is categorised: known provider keys, GitHub token, unrecognised apiKey.*
 * entries, and a redacted count for other stored secrets.
 */
export class ListApiKeysTool extends defineTool({
  name: 'list_api_keys',
  description: `Audit TeXRA's SecretStorage without reading secret values. Known provider keys are shown by provider name (e.g. \`anthropic\`); unrecognised \`apiKey.*\` entries are shown by raw key name to help identify stale secrets; other secret key names are counted but redacted because they may contain user-derived identifiers. Use this to check which providers have a key configured and to detect stale API-key entries. Recognised providers can be managed with set_api_key / unset_api_key; unrecognised apiKey.* entries (e.g. from renamed providers) cannot be deleted via those tools — the user must clear them with VS Code's "Delete Secret" command. Prefer probe_environment for a fuller overview that also covers tool installations and auth status.`,
  schema: ListApiKeysInputSchema,
}) {
  protected async execute(_input: ListApiKeysInput): Promise<ToolResult> {
    const platform = getSetupPlatform();
    const storedKeys = await platform.secrets.listStoredKeys();

    if (storedKeys.length === 0) {
      return {
        summary: 'No secrets stored',
        output: 'SecretStorage is empty — no API keys or tokens are stored.',
      };
    }

    const { providers } = platform.secrets;
    const knownProviderKeyMap = new Map(
      providers.map((p) => [apiKeySecretName(p), p] as const),
    );

    const providerKeys: string[] = [];
    const unknownApiKeys: string[] = [];
    let hasGithubToken = false;
    const otherKeys: string[] = [];

    for (const key of storedKeys) {
      const provider = knownProviderKeyMap.get(key);
      if (provider !== undefined) {
        providerKeys.push(provider);
      } else if (key === GITHUB_TOKEN_STORAGE_KEY) {
        hasGithubToken = true;
      } else if (key.startsWith('apiKey.')) {
        unknownApiKeys.push(key);
      } else {
        otherKeys.push(key);
      }
    }

    const missingProviders = providers.filter((p) => !providerKeys.includes(p));

    const lines: string[] = [`Stored secrets (${storedKeys.length} total):`];

    if (providerKeys.length > 0) {
      lines.push('', 'Provider API keys stored:');
      for (const p of providerKeys) lines.push(`  ${p}`);
    } else {
      lines.push('', 'No provider API keys stored.');
    }

    if (missingProviders.length > 0) {
      lines.push('', 'Providers without a stored key:');
      for (const p of missingProviders) lines.push(`  ${p}`);
    }

    if (unknownApiKeys.length > 0) {
      lines.push(
        '',
        'Unrecognised apiKey.* entries (diagnostic only, not unset_api_key providers):',
      );
      for (const k of unknownApiKeys) lines.push(`  ${k}`);
    }

    if (hasGithubToken) {
      lines.push('', 'GitHub token: stored');
    }

    if (otherKeys.length > 0) {
      lines.push(
        '',
        `Other stored secrets: ${otherKeys.length} redacted key name${otherKeys.length === 1 ? '' : 's'}`,
      );
    }

    const providerSummary =
      providerKeys.length === 0
        ? 'no provider keys'
        : `${providerKeys.length}/${providers.length} provider keys`;

    return {
      summary: `${storedKeys.length} stored secret${storedKeys.length === 1 ? '' : 's'}: ${providerSummary}`,
      output: lines.join('\n'),
    };
  }
}
