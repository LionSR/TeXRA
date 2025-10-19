// Local imports - webview
import { ELEMENT_IDS } from '../constants.js';
import { RecordingButtonManager } from '@common/RecordingButtonManager.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';

export class RecordingManager {
  constructor(vscode) {
    this.buttonManager = new RecordingButtonManager(vscode, {
      buttonId: ELEMENT_IDS.RECORD_INSTRUCTION_BUTTON,
      startCommand: MAIN_VIEW_COMMANDS.START_RECORDING,
      stopCommand: MAIN_VIEW_COMMANDS.STOP_RECORDING,
      startTitle: 'Record instruction with microphone',
      stopTitle: 'Stop recording',
    });
  }

  setupRecordButton() {
    this.buttonManager.setup();
  }

  setRecording(recording) {
    this.buttonManager.setRecording(recording);
  }
}
