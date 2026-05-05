import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import {
  DESKTOP_LOCAL_COMMANDS,
  dispatchDesktopCommand,
  getDesktopCommandMenuEntries,
} from '../../../packages/desktop/src/desktopCommandSurface';

describe('desktop command surface', () => {
  it('includes workspace and log commands in the palette entries', () => {
    const entries = getDesktopCommandMenuEntries();
    const labelsById = new Map(entries.map((entry) => [entry.id, entry.label]));

    assert.equal(
      labelsById.get(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER),
      'Open Folder',
    );
    assert.equal(
      labelsById.get(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
      'Open Logs Folder',
    );
  });

  it('routes desktop-only commands through shell actions', () => {
    let openedWorkspace = false;
    let openedLogs = false;

    assert.equal(
      dispatchDesktopCommand(DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER, {
        showRoute: () => undefined,
        showSettings: () => undefined,
        openWorkspaceFolder: () => {
          openedWorkspace = true;
        },
      }),
      true,
    );
    assert.equal(
      dispatchDesktopCommand(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER, {
        showRoute: () => undefined,
        showSettings: () => undefined,
        openLogFolder: () => {
          openedLogs = true;
        },
      }),
      true,
    );

    assert.equal(openedWorkspace, true);
    assert.equal(openedLogs, true);
  });
});
