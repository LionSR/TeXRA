/**
 * Tool dashboard message construction.
 *
 * The expensive bits (probing external binaries, building items) live in the
 * extension/desktop tool-availability code, but both hosts wrap the result
 * in the same outbound message — extracted here to keep that in one place.
 */
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import type {
  ToolDashboardItem,
  UpdateToolDashboardMessage,
} from '@shared/schemas/settingsViewMessages';

export function buildToolDashboardMessage(
  items: ToolDashboardItem[],
): UpdateToolDashboardMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
    items,
  };
}
