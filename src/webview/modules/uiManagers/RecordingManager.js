// Local imports - webview
import { ELEMENT_IDS } from '../constants.js';
import { webviewEventBus } from '../eventBus.js';
import { RecordingButtonManager } from '@common/recordingButtonManager.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';

export class RecordingManager {
  constructor(vscode, eventBus = webviewEventBus) {
    this._controller = new RecordingButtonManager({
      buttonId: ELEMENT_IDS.RECORD_INSTRUCTION_BUTTON,
      vscode,
      startCommand: MAIN_VIEW_COMMANDS.START_RECORDING,
      stopCommand: MAIN_VIEW_COMMANDS.STOP_RECORDING,
      eventTarget: eventBus,
      idleTitle: 'Record instruction with microphone',
      recordingTitle: 'Stop recording',
    });
  }

  updateRecordingUI(recording) {
    this._controller.setRecording(recording);
  }

  setupRecordButton() {
    this._controller.setup();
  }
}
