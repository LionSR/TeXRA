import { getWebviewState, updateWebviewState } from '@common/webviewState.js';

// State variables
let currentStream = '';
let streamStatuses = new Map();
let logGroups = new Map(); // groupId -> group details
let groupToggleStates = new Map(); // groupId -> collapsed state

/**
 * Initializes state from previously saved state
 */
export function initializeState() {
  const previousState = getWebviewState();
  if (previousState.groupToggleStates) {
    try {
      groupToggleStates = new Map(JSON.parse(previousState.groupToggleStates));
    } catch (e) {
      console.error('Failed to restore group toggle states:', e);
    }
  }
}

/**
 * Saves the current state to vscode state storage
 */
export function saveState() {
  try {
    // Convert the groupToggleStates Map to an array for JSON serialization
    const serializedGroupStates = JSON.stringify([
      ...groupToggleStates.entries(),
    ]);
    updateWebviewState({
      groupToggleStates: serializedGroupStates,
    });
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

/**
 * Get the current active stream
 * @returns {string} The current stream
 */
export function getCurrentStream() {
  return currentStream;
}

/**
 * Set the current active stream
 * @param {string} stream - The stream to set as current
 */
export function setCurrentStream(stream) {
  currentStream = stream;
}

/**
 * Get the stream status for a given stream
 * @param {string} stream - The stream to get status for
 * @returns {string} The status of the stream
 */
export function getStreamStatus(stream) {
  return streamStatuses.get(stream);
}

/**
 * Set the status for a stream
 * @param {string} stream - The stream to set status for
 * @param {string} status - The status to set
 */
export function setStreamStatus(stream, status) {
  if (stream && status !== 'ready') {
    streamStatuses.set(stream, status);
  }
}

/**
 * Delete a stream from the statuses map
 * @param {string} stream - The stream to delete
 */
export function deleteStreamStatus(stream) {
  streamStatuses.delete(stream);
}

/**
 * Clear group toggle states for specific groups
 * @param {Array} groupIds - Array of group IDs to clear toggle states for
 */
export function clearGroupToggleStates(groupIds) {
  for (const groupId of groupIds) {
    groupToggleStates.delete(groupId);
  }
  saveState();
}

/**
 * Get a log group by ID
 * @param {string} groupId - The ID of the group to get
 * @returns {Object} The log group
 */
export function getLogGroup(groupId) {
  return logGroups.get(groupId);
}

/**
 * Set a log group
 * @param {string} groupId - The ID of the group to set
 * @param {Object} group - The group data
 */
export function setLogGroup(groupId, group) {
  logGroups.set(groupId, group);
}

/**
 * Clear all log groups
 */
export function clearLogGroups() {
  logGroups.clear();
}

/**
 * Get all log groups
 * @returns {Map} The log groups map
 */
export function getLogGroups() {
  return logGroups;
}

/**
 * Set the collapsed state for a group
 * @param {string} groupId - The ID of the group
 * @param {boolean} isCollapsed - Whether the group is collapsed
 */
export function setGroupToggleState(groupId, isCollapsed) {
  groupToggleStates.set(groupId, isCollapsed);
  saveState();
}

/**
 * Get the collapsed state for a group
 * @param {string} groupId - The ID of the group
 * @returns {boolean} Whether the group is collapsed
 */
export function getGroupToggleState(groupId) {
  return groupToggleStates.get(groupId);
}

/**
 * Clear all group toggle states
 */
export function clearAllGroupToggleStates() {
  groupToggleStates.clear();
  saveState();
}
