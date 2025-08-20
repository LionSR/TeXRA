// Local imports - webview
import { webviewEventBus } from '../eventBus.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';

/**
 * Handlers related to recording state.
 * @param {Object} ctx
 * @param {Function} ctx.postHandle
 */
export function createRecordingHandlers({ postHandle }) {
  function handleRecordingStarted() {
    webviewEventBus.dispatchEvent(
      new CustomEvent('recordingUIUpdate', { detail: { recording: true } }),
    );
    postHandle();
  }

  function handleRecordingError() {
    webviewEventBus.dispatchEvent(
      new CustomEvent('recordingUIUpdate', { detail: { recording: false } }),
    );
    postHandle();
  }

  return {
    [MAIN_VIEW_COMMANDS.RECORDING_STARTED]: handleRecordingStarted,
    [MAIN_VIEW_COMMANDS.RECORDING_ERROR]: handleRecordingError,
  };
}
