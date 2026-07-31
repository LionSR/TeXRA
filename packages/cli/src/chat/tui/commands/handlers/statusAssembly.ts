import {
  loadCliApiStatus,
  loadCliModelAccessOverview,
} from '@cli/runtime/apiStatus';
import type { ApiAccessMode } from '@shared/schemas/profileViewMessages';

/** Load the canonical account snapshot used by TUI account commands. */
export async function loadCliAccountStatusLines(options: {
  readonly apiMode: ApiAccessMode;
  readonly includeApiDetails?: boolean;
}): Promise<string[]> {
  const [overview, apiStatus] = await Promise.all([
    loadCliModelAccessOverview({ apiMode: options.apiMode }),
    options.includeApiDetails
      ? loadCliApiStatus({ apiMode: options.apiMode })
      : Promise.resolve(undefined),
  ]);
  const detailLines =
    apiStatus?.detailLines.filter((line) => !overview.lines.includes(line)) ??
    [];
  return [...overview.lines, ...detailLines];
}
