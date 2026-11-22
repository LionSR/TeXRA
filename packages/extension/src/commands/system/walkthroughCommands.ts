// Third-party imports
import { Effect } from 'effect';

// Local imports
import { withLogChannel } from '@texra-ai/worldline/plugins';
import { safeExecuteCommand } from '@frontend/system/commandUtils';

const GETTING_STARTED_WALKTHROUGH_ID = 'texra.gettingStarted';
const CHANNEL = 'walkthroughCommands';

/** A walkthrough VS Code would not open is reported once, as any other
 *  failed command. */
export function openGettingStarted(extensionId: string) {
  return Effect.asVoid(
    safeExecuteCommand('workbench.action.openWalkthrough', [
      `${extensionId}#${GETTING_STARTED_WALKTHROUGH_ID}`,
    ]),
  ).pipe(withLogChannel(CHANNEL));
}
