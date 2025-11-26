// Local imports - profile view
import { profileViewState } from './profileViewState.js';
import { AgentsTable } from './uiManagers/AgentsTable.js';
import { ProfileEventsManager } from './uiManagers/ProfileEventsManager.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';

/**
 * Coordinates the profile view DOM managers.
 */
class ProfileViewDomHandler extends BaseDomHandler {
  constructor() {
    const agentsTable = new AgentsTable(profileViewState);
    super({
      agentsTable,
      events: new ProfileEventsManager(agentsTable),
    });
  }
}

export const profileViewDomHandler = new ProfileViewDomHandler();
