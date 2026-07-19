import { getServerSideKeyService } from '@auth/serverKeys';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';

export type CliApiMode = 'included' | 'personal';

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
} as const satisfies Record<string, CliApiMode>;

type CliApiModeInput = keyof typeof CLI_API_MODE_BY_INPUT;

export const CLI_API_MODE_INPUTS = Object.keys(
  CLI_API_MODE_BY_INPUT,
) as readonly CliApiModeInput[];

export function getCliApiMode(): CliApiMode {
  return getServerSideKeyService().getUseIncludedModelAccess()
    ? 'included'
    : 'personal';
}

export function effectiveCliApiMode(source: {
  readonly apiMode?: CliApiMode;
}): CliApiMode {
  return source.apiMode ?? getCliApiMode();
}

export function shortCliApiMode(mode: CliApiMode): string {
  return mode === 'included' ? 'included' : 'personal';
}

export function parseCliApiMode(input: string): CliApiMode | undefined {
  const normalized = input.trim().toLowerCase();
  return Object.hasOwn(CLI_API_MODE_BY_INPUT, normalized)
    ? CLI_API_MODE_BY_INPUT[normalized as CliApiModeInput]
    : undefined;
}

export async function enableCliIncludedModelAccess(): Promise<void> {
  await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
  await getServerSideKeyService().setUseIncludedModelAccess(true);
  invalidateModelOptionsCache();
}

export async function setCliApiMode(mode: CliApiMode): Promise<void> {
  if (mode === 'included') {
    await enableCliIncludedModelAccess();
    return;
  }
  await getServerSideKeyService().setUseIncludedModelAccess(false);
  invalidateModelOptionsCache();
}
