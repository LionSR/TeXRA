// Local imports - webview
import { ELEMENT_IDS } from '../constants.js';
import { webviewEventBus } from '../eventBus.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { RecordingButtonManager } from '@common/modules/RecordingButtonManager.js';

export class RecordingManager extends RecordingButtonManager {
  constructor(vscode, eventBus = webviewEventBus) {
    super({
      vscode,
      buttonId: ELEMENT_IDS.RECORD_INSTRUCTION_BUTTON,
      startCommand: MAIN_VIEW_COMMANDS.START_RECORDING,
      stopCommand: MAIN_VIEW_COMMANDS.STOP_RECORDING,
      idleTitle: 'Record instruction with microphone',
      recordingTitle: 'Stop recording',
      eventBus,
    });
  }

  updateRecordingUI(recording) {
    this.setRecording(recording);
  }

  setupRecordButton() {
    this.setup();
  }
}
