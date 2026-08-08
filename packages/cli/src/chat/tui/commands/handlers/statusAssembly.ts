import {
  loadCliDetailedAccountStatusLines,
  loadCliModelAccessOverview,
} from '@cli/runtime/apiStatus';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';

/** Load the canonical account snapshot used by TUI account commands. */
export async function loadCliAccountStatusLines(options: {
  readonly apiMode: ApiAccessMode;
  readonly includeApiDetails?: boolean;
}): Promise<string[]> {
  if (options.includeApiDetails) {
    return loadCliDetailedAccountStatusLines({ apiMode: options.apiMode });
  }
  return [
    ...(await loadCliModelAccessOverview({ apiMode: options.apiMode })).lines,
  ];
}
