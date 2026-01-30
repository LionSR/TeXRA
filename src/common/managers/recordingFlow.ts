// Third-party imports
import * as vscode from 'vscode';

// Local imports - recording manager
import {
  RecordingManager,
  type RecordingManagerConfig,
} from '@common/managers/RecordingManager';

export type RecordingCommandMap = RecordingManagerConfig;

export function wireRecordingFlow(
  context: vscode.ExtensionContext,
  commands: RecordingCommandMap,
): RecordingManager {
  return new RecordingManager(context, commands);
}
