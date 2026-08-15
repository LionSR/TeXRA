import { getServerSideKeyService } from '@auth/serverKeys';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { platform } from '@platform/platform';
import type { ApiAccessMode } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

export interface CliApiModeUpdate {
  readonly mode: ApiAccessMode;
  readonly openRouterDisabled: boolean;
}

// Two canonical names per mode: the descriptive `included`/`personal` (used in
// labels and config) plus the common shorthand `relay`/`byok` (accepted as
// input aliases). Earlier builds also accepted `texra`/`direct`/`api`/`key`/
// `keys`, but those undocumented synonyms only bloated the accepted-value list
// without adding clarity.
const CLI_API_MODE_BY_INPUT = {
  included: 'included',
  relay: 'included',
  personal: 'personal',
  byok: 'personal',
} as const satisfies Record<string, ApiAccessMode>;

type CliApiModeInput = keyof typeof CLI_API_MODE_BY_INPUT;

export const CLI_API_MODE_INPUTS = Object.keys(
  CLI_API_MODE_BY_INPUT,
) as readonly CliApiModeInput[];

export function getCliApiMode(): ApiAccessMode {
  return getServerSideKeyService().getUseIncludedModelAccess()
    ? 'included'
    : 'personal';
}

export function effectiveCliApiMode(source: {
  readonly apiMode?: ApiAccessMode;
}): ApiAccessMode {
  return source.apiMode ?? getCliApiMode();
}

export function parseCliApiMode(input: string): ApiAccessMode | undefined {
  const normalized = input.trim().toLowerCase();
  return Object.hasOwn(CLI_API_MODE_BY_INPUT, normalized)
    ? CLI_API_MODE_BY_INPUT[normalized as CliApiModeInput]
    : undefined;
}

export async function setCliApiMode(
  mode: ApiAccessMode,
): Promise<CliApiModeUpdate> {
  const includedAccess = mode === 'included';
  await getServerSideKeyService().setUseIncludedModelAccess(includedAccess);

  let openRouterDisabled = false;
  if (
    includedAccess &&
    platform().globalState.get<boolean>(GlobalStateKey.USE_OPENROUTER, false)
  ) {
    // Included Access routes through the TeXRA relay; OpenRouter bypasses it.
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    openRouterDisabled = true;
  }

  invalidateModelOptionsCache();
  return { mode, openRouterDisabled };
}
