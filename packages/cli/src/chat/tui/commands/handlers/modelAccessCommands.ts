import { Effect } from 'effect';

import { loadCliDetailedAccountStatusLines } from '@cli/runtime/apiStatus';
import { bumpCodexPreferenceVersion } from '@cli/chat/tui/state/cliState';
import { saveProviderApiKey } from '@cli/runtime/providerApiKey';
import {
  parseCliModelAccessSelection,
  type CliModelAccessSelection,
} from '@cli/runtime/modelAccessRoute';
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

const MODEL_ACCESS_USAGE =
  'Usage: /api chatgpt | grok | kimi-code | glm-code | status';

/**
 * Save a provider key and refresh access-dependent TUI views. Returns only the
 * extra notice a provider needs, if any — the caller owns the
 * "Saved the <provider> API key." confirmation line.
 */
export const applyCliProviderApiKey = Effect.fn('applyCliProviderApiKey')(
  function* (secrets: PlatformSecrets, provider: ApiProvider, key: string) {
    yield* saveProviderApiKey(secrets, provider, key);
    bumpCodexPreferenceVersion();
    const codingPlan = codingPlanForApiProvider(provider);
    if (!codingPlan) return undefined;
    if (!codingPlan.exclusiveCredential) {
      return `Tip: ${codingPlan.retryFallbackName} is the default; enable '${codingPlan.preferenceLabel}' with \`/api ${codingPlan.cliProvider}\` or in \`/config\` to use ${codingPlan.displayName}.`;
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
    {
      writeProgress: (message) =>
        output.writeProgress(message, { copyable: true }),
    },
  );
  bumpCodexPreferenceVersion();
  output.appendOutcome(collapseWhitespace(access.message));
});

export const applyCliModelAccessInput = Effect.fn('applyCliModelAccessInput')(
  function* (
    stores: SettingsStores,
    routeInput: string,
    context: SlashCommandContext,
    output: SlashCommandOutput = transcriptSlashCommandOutput,
  ) {
    const normalized = routeInput.trim().toLowerCase();

    if (!normalized || normalized === 'status') {
      const lines = yield* loadCliDetailedAccountStatusLines(
        context.stores,
        context.secrets,
      );
      output.appendOutcome(lines.join('\n'));
      return;
    }

    const selection = parseCliModelAccessSelection(normalized);
    if (!selection) {
      output.setNotice(MODEL_ACCESS_USAGE);
      return;
    }

    yield* applyCliModelAccessSelection(stores, selection, context, output);
  },
);

export const showCliAuthStatus = Effect.fn('showCliAuthStatus')(function* (
  stores: SettingsStores,
  secrets: PlatformSecrets,
) {
  const lines = yield* loadCliDetailedAccountStatusLines(stores, secrets);
  transcriptSlashCommandOutput.appendOutcome(lines.join('\n'));
});
