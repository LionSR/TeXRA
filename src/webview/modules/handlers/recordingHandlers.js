// Local imports - webview
import { recordingManager } from '../domHandlers.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';

/**
 * Handlers related to recording state.
 * @param {Object} ctx
 * @param {Function} ctx.postHandle
 */
export function createRecordingHandlers({ postHandle }) {
  function handleRecordingStarted() {
    recordingManager.setRecording(true);
    postHandle();
  }

  function handleRecordingError() {
    recordingManager.setRecording(false);
    postHandle();
  }

  return {
    [MAIN_VIEW_COMMANDS.RECORDING_STARTED]: handleRecordingStarted,
    [MAIN_VIEW_COMMANDS.RECORDING_ERROR]: handleRecordingError,
  };
}
