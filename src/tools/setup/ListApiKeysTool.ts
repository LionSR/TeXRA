// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { hostPort } from '@common/hostPort';
import { API_PROVIDERS, apiKeySecretName } from '@model/apiProviders';
import { Secrets } from '@platform/secrets';
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';
import { executed } from '@tools/core/result';
import { formatResultCount } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from '../core/define';

const ListApiKeysInputSchema = z
  .strictObject({})
  .describe(
    "No inputs: audits secret key names in TeXRA's persisted credential store.",
  );

type ListApiKeysInput = z.infer<typeof ListApiKeysInputSchema>;

const listApiKeys = Effect.fn('ListApiKeysTool.execute')(function* () {
  const secrets = yield* Secrets;
  const storedKeys = yield* hostPort(() => secrets.listStoredKeys());

  if (storedKeys.length === 0) {
    return executed(
      'The credential store is empty: no API keys or tokens are persisted.',
      'No secrets stored',
    );
  }

  const knownProviderKeyMap = new Map(
    API_PROVIDERS.map((p) => [apiKeySecretName(p), p] as const),
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

  const missingProviders = API_PROVIDERS.filter(
    (p) => !providerKeys.includes(p),
  );

  const lines: string[] = [`Stored secrets (${storedKeys.length} total):`];

  if (providerKeys.length > 0) {
    lines.push('', 'Provider API keys stored:');
    for (const p of providerKeys) lines.push(`  ${p}`);
  } else {
    lines.push('', 'No provider API keys persisted in TeXRA secrets.');
  }

  if (missingProviders.length > 0) {
    lines.push(
      '',
      'Providers without a key in TeXRA secrets (environment not checked here):',
    );
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
      `Other stored secrets: ${formatResultCount(otherKeys.length, 'redacted key name')}`,
    );
  }

  const providerSummary =
    providerKeys.length === 0
      ? 'no persisted provider API keys'
      : `${providerKeys.length}/${API_PROVIDERS.length} persisted provider API keys`;

  return executed(
    lines.join('\n'),
    `${formatResultCount(storedKeys.length, 'stored secret')}: ${providerSummary}`,
  );
});

/**
 * Audit persisted secret key *names* without reading their values.
 *
 * The result is categorised as known provider keys, the GitHub token,
 * unrecognised apiKey.* entries, and a redacted count for other secrets.
 */
export const ListApiKeysTool = defineTool({
  name: 'list_api_keys',
  description: `Audit only TeXRA's persisted credential store without reading secret values. Environment-backed provider keys are deliberately excluded and are reported by probe_environment instead. Known persisted provider keys are shown by provider name (e.g. \`anthropic\`); unrecognised \`apiKey.*\` entries are shown by raw key name to help identify stale secrets; other secret key names are counted but redacted because they may contain user-derived identifiers. Use this to detect persisted provider keys and stale API-key entries. Recognised providers can be removed with unset_api_key; other entries must be removed through the current host's credential-management surface.`,
  schema: ListApiKeysInputSchema,
  execute: (_input: ListApiKeysInput) => listApiKeys(),
});
