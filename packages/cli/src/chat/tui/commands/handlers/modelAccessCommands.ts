import { Effect } from 'effect';

import { emitAppSignal, type SettingsStores } from '@texra-ai/harness/plugins';

import { type ApiKeyProviderId } from '@texra-ai/llm';
import { loadCliDetailedAccountStatusLines } from '@cli/runtime/models/apiStatus';
import { commitCliProviderApiKey } from '@cli/chat/tui/hosts/cliProviderKeys';
import { type CliModelAccessSelection } from '@cli/runtime/models/modelAccessRoute';
import { updateCliModelAccess } from '@cli/runtime/models/modelAccessSelection';

import { CODING_PLAN_BY_API_PROVIDER } from '@texra/shared/model/codingPlans';
import { planFallbackName } from '@ui/copy/modelAccess';
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
  function* (stores: SettingsStores, provider: ApiKeyProviderId, key: string) {
    yield* commitCliProviderApiKey(stores, provider, key);
    const codingPlan = CODING_PLAN_BY_API_PROVIDER.get(provider);
    if (!codingPlan) return undefined;
    if (!codingPlan.exclusiveCredential) {
      return `Tip: ${planFallbackName(codingPlan.usageRoute)} is the default; enable '${codingPlan.preferenceLabel}' in \`/login\` or \`/config\` to use ${codingPlan.displayName}.`;
    }
    // The coding-only models route through the subscription automatically;
    // dual-backend K3 needs the opt-in switch, which is only discoverable if
    // we name it here — the same name `/config` and `/login` show.
    return "Tip: the Kimi for Coding models use your subscription automatically; to use it for Kimi K3 too, enable 'Kimi Code subscription' in /config.";
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
  yield* emitAppSignal('modelAccessChanged', undefined);
  output.appendOutcome(access.message);
});

/** `/login status`: every sign-in, route preference, and quota in one list. */
export const showCliAccountStatus = Effect.fn('showCliAccountStatus')(
  function* (stores: SettingsStores) {
    const lines = yield* loadCliDetailedAccountStatusLines(stores);
    transcriptSlashCommandOutput.appendOutcome(lines.join('\n'));
  },
);
