// Third-party imports
import { Effect } from 'effect';

// Local imports
import { safeExecuteCommand } from '@frontend/system/commandUtils';

const GETTING_STARTED_WALKTHROUGH_ID = 'texra.gettingStarted';
const CHANNEL = 'walkthroughCommands';

/** A refused walkthrough is reported once, as any other refused command. */
export function openGettingStarted(extensionId: string) {
  return Effect.asVoid(
    safeExecuteCommand(
      'workbench.action.openWalkthrough',
      [`${extensionId}#${GETTING_STARTED_WALKTHROUGH_ID}`],
      CHANNEL,
    ),
  );
}
