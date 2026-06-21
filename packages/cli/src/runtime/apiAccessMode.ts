// Local imports - auth
import { getServerSideKeyService } from '@auth/serverKeys';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

export type CliApiMode = 'included' | 'personal';

const CLI_API_MODE_BY_INPUT = {
  included: 'included',
  relay: 'included',
  texra: 'included',
  personal: 'personal',
  direct: 'personal',
  api: 'personal',
  byok: 'personal',
  key: 'personal',
  keys: 'personal',
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

export function formatCliApiMode(mode: CliApiMode): string {
  return mode === 'included' ? 'included relay' : 'personal API keys';
}

export function shortCliApiMode(mode: CliApiMode): string {
  return mode === 'included' ? 'relay' : 'byok';
}

export function parseCliApiMode(input: string): CliApiMode | undefined {
  const normalized = input.trim().toLowerCase();
  return Object.hasOwn(CLI_API_MODE_BY_INPUT, normalized)
    ? CLI_API_MODE_BY_INPUT[normalized as CliApiModeInput]
    : undefined;
}

export async function setCliApiMode(mode: CliApiMode): Promise<void> {
  await getServerSideKeyService().setUseIncludedModelAccess(
    mode === 'included',
  );
  invalidateModelOptionsCache();
}
