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
    const { title, description } = codingPlan.preference;
    // The switch is named as `/config` and `/login` show it; what it routes
    // is its setting row's description, so no model is named here by hand.
    const opener = codingPlan.exclusiveCredential
      ? `the ${codingPlan.displayName} models use your subscription automatically`
      : `${planFallbackName(codingPlan.usageRoute)} is the default`;
    return `Tip: ${opener}. '${title}' in \`/login\` or \`/config\`: ${description}`;
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
