import { Effect } from 'effect';

import { loadCliDetailedAccountStatusLines } from '@cli/runtime/apiStatus';
import { bumpCodexPreferenceVersion } from '@cli/chat/tui/state/cliState';
import { commitCliProviderApiKey } from '@cli/chat/tui/hosts/cliProviderKeys';
import { type CliModelAccessSelection } from '@cli/runtime/modelAccessRoute';
import { updateCliModelAccess } from '@cli/runtime/modelAccessSelection';

import type { ApiProvider } from '@model/apiProviders';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { codingPlanForApiProvider } from '@shared/codingPlanSubscriptions';
import { collapseWhitespace } from '@utils/text/stringUtils';
import {
  type SlashCommandOutput,
  type SlashCommandContext,
  transcriptSlashCommandOutput,
} from './slashContext';

/**
 * Save a provider key through the shared key controller and answer the extra
 * notice a provider needs, if any. The controller owns the write, the
 * "<provider> API key has been set" confirmation and the post-write refresh
 * on every host, so only the coding-plan tip is worded here.
 */
export const applyCliProviderApiKey = Effect.fn('applyCliProviderApiKey')(
  function* (
    secrets: PlatformSecrets,
    stores: SettingsStores,
    provider: ApiProvider,
    key: string,
  ) {
    yield* commitCliProviderApiKey(secrets, stores, provider, key);
    const codingPlan = codingPlanForApiProvider(provider);
    if (!codingPlan) return undefined;
    if (!codingPlan.exclusiveCredential) {
      return `Tip: ${codingPlan.retryFallbackName} is the default; enable '${codingPlan.preferenceLabel}' in \`/login\` or \`/config\` to use ${codingPlan.displayName}.`;
    }
    // The coding-only models route through the subscription automatically;
    // dual-backend K3 needs the opt-in switch, which is only discoverable if
    // we name it here.
    return "Tip: the Kimi for Coding models use your subscription automatically; to use it for Kimi K3 too, enable 'Prefer Kimi Code' in /config.";
  },
);

/**
 * Apply one model-access choice. Cancellation is the caller interrupting this
 * program: the sign-in it drives stops where it stands, so there is no
 * separate abort channel.
 */
export const applyCliModelAccessSelection = Effect.fn(
  'applyCliModelAccessSelection',
)(function* (
  stores: SettingsStores,
  selection: CliModelAccessSelection,
  context: SlashCommandContext | undefined,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
) {
  const access = yield* updateCliModelAccess(
    stores,
    context?.cliContext,
    selection,
    { writeProgress: output.writeProgress },
  );
  bumpCodexPreferenceVersion();
  output.appendOutcome(collapseWhitespace(access.message));
});

/** `/login status`: every sign-in, route preference, and quota in one list. */
export const showCliAccountStatus = Effect.fn('showCliAccountStatus')(
  function* (stores: SettingsStores, secrets: PlatformSecrets) {
    const lines = yield* loadCliDetailedAccountStatusLines(stores, secrets);
    transcriptSlashCommandOutput.appendOutcome(lines.join('\n'));
  },
);
