// Local imports
import { truncateWithEllipsis } from '@utils/text/stringUtils';

/**
 * Normalize a child task's raw label to the ≤80-char description
 * `registerRun` writes as the run's one `run.description` row.
 */
export function childRunDescription(raw: string): string {
  return truncateWithEllipsis(raw, 80);
}
