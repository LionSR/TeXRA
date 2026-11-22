import { Effect } from 'effect';

import type { SettingsStores } from '@texra-ai/worldline/plugins';

import { type ApiKeyProviderId } from '@texra-ai/llm';
import { loadCliDetailedAccountStatusLines } from '@cli/runtime/models/apiStatus';
import { tuiUi } from '@cli/chat/tui/hosts/tuiUiHost';
import { commitProviderKey } from '@texra/controllers/settingsView/providerKeyActions';
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
 * Save a provider key through the shared key action and answer the extra
 * notice a provider needs, if any. That action owns the write, the
 * "<provider> API key has been set" confirmation and the post-write refresh
 * on every host, so only the coding-plan tip is worded here.
 */
export const applyCliProviderApiKey = Effect.fn('applyCliProviderApiKey')(
  function* (stores: SettingsStores, provider: ApiKeyProviderId, key: string) {
    yield* commitProviderKey(tuiUi, stores, provider, key);
    const codingPlan = CODING_PLAN_BY_API_PROVIDER.get(provider);
    if (!codingPlan) return undefined;
    if (!codingPlan.exclusiveCredential) {
      return `Tip: ${planFallbackName(codingPlan.usageRoute)} is the default; enable '${codingPlan.preference.title}' in \`/login\` or \`/config\` to use ${codingPlan.displayName}.`;
    }
    // The coding-only models route through the subscription automatically;
    // dual-backend K3 needs the opt-in switch, which is only discoverable if
    // we name it here — the same name `/config` and `/login` show.
    return `Tip: the Kimi for Coding models use your subscription automatically; to use it for Kimi K3 too, enable '${codingPlan.preference.title}' in /config.`;
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
  selection: CliModelAccessSelection,
  context: SlashCommandContext,
  output: SlashCommandOutput,
) {
  const access = yield* updateCliModelAccess(
    context.stores,
    context.cliContext,
    selection,
    { writeProgress: output.writeProgress },
  );
  output.appendOutcome(access.message);
});

/** `/login status`: every sign-in, route preference, and quota in one list. */
export const showCliAccountStatus = Effect.fn('showCliAccountStatus')(
  function* (stores: SettingsStores) {
    const lines = yield* loadCliDetailedAccountStatusLines(stores);
    transcriptSlashCommandOutput.appendOutcome(lines.join('\n'));
  },
);
