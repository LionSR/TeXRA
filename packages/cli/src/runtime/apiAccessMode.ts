// Local imports - auth
import { getServerSideKeyService } from '@auth/serverKeys';

export type CliApiMode = 'included' | 'personal';

export function getCliApiMode(): CliApiMode {
  return getServerSideKeyService().getUseIncludedModelAccess()
    ? 'included'
    : 'personal';
}

export function formatCliApiMode(mode: CliApiMode): string {
  return mode === 'included' ? 'included relay' : 'personal API keys';
}

export function shortCliApiMode(mode: CliApiMode): string {
  return mode === 'included' ? 'relay' : 'api';
}

export function parseCliApiMode(input: string): CliApiMode | undefined {
  const normalized = input.trim().toLowerCase();
  if (['personal', 'api', 'byok', 'key', 'keys'].includes(normalized)) {
    return 'personal';
  }
  if (['included', 'relay', 'texra'].includes(normalized)) {
    return 'included';
  }
  return undefined;
}

export async function setCliApiMode(mode: CliApiMode): Promise<void> {
  await getServerSideKeyService().setUseIncludedModelAccess(
    mode === 'included',
  );
}
