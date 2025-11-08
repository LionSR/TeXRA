// Local imports - progress view
// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Manages task groups in the progress view.
 */
class TaskGroups {
  constructor() {
    this.groups = new Map();
    this._cachedTotals = null;
  }

  get(id) {
    if (!id) {
      console.error('TaskGroups.get: id is required');
      return null;
    }
    return this.groups.get(id);
  }

  set(id, group) {
    if (!id) {
      console.error('TaskGroups.set: id is required');
      return;
    }
    if (!group || typeof group !== 'object') {
      console.error('TaskGroups.set: group must be an object');
      return;
    }
    this.groups.set(id, group);
    this._cachedTotals = null; // Invalidate cache
  }

  getGroupMap() {
    return this.groups;
  }

  clear() {
    this.groups.clear();
    this._cachedTotals = null; // Invalidate cache
  }

  /**
   * Update an existing log group with a structured payload.
   * @param {{ groupId: string, updates?: Object }} payload
   */
  update(payload) {
    if (!payload || typeof payload !== 'object') {
      console.error('TaskGroups.update: payload must be an object');
      return;
    }

    const { groupId, updates = {} } = payload;
    if (!groupId) {
      console.error('TaskGroups.update: groupId is required');
      return;
    }

    const group = this.groups.get(groupId);
    if (!group) {
      console.error(`TaskGroups.update: group not found for id ${groupId}`);
      return;
    }

    const hasStatusUpdate = Object.prototype.hasOwnProperty.call(
      updates,
      'status',
    );
    if (hasStatusUpdate && updates.status) {
      group.status = updates.status;
    }
    if (
      Object.prototype.hasOwnProperty.call(updates, 'endTime') &&
      updates.endTime !== undefined &&
      updates.endTime !== null
    ) {
      group.endTime = updates.endTime;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'usage')) {
      group.usage = updates.usage;
    }

    this.groups.set(groupId, group);
    this._cachedTotals = null; // Invalidate cache
  }
}

/**
 * Manages group toggle states with persistence.
 */
class ToggleStates {
  constructor(saveCallback) {
    this.states = new Map();
    this.saveCallback = saveCallback;
  }

  set(id, collapsed) {
    if (!id) {
      console.error('ToggleStates.set: id is required');
      return;
    }
    if (typeof collapsed !== 'boolean') {
      console.error('ToggleStates.set: collapsed must be a boolean');
      return;
    }
    this.states.set(id, collapsed);
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  get(id) {
    return this.states.get(id);
  }

  clearSelection(ids) {
    if (!Array.isArray(ids)) {
      console.error('ToggleStates.clearSelection: ids must be an array');
      return;
    }
    ids.forEach((id) => {
      if (id) {
        this.states.delete(id);
      }
    });
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  clearAll() {
    this.states.clear();
    if (this.saveCallback) {
      this.saveCallback();
    }
  }

  /** Get all entries for serialization */
  entries() {
    return [...this.states.entries()];
  }

  /** Load from serialized data */
  load(data) {
    this.states = new Map(data);
  }
}

/**
 * Manages stream status information.
 */
class StreamStatuses {
  constructor() {
    this.statuses = new Map();
  }

  get(stream) {
    return this.statuses.get(stream);
  }

  set(stream, status) {
    if (!stream) {
      console.error('StreamStatuses.set: stream is required');
      return;
    }
    if (!status) {
      console.error('StreamStatuses.set: status is required');
      return;
    }
    if (typeof status !== 'string') {
      console.error('StreamStatuses.set: status must be a string');
      return;
    }
    if (status !== 'ready') {
      this.statuses.set(stream, status);
    }
  }

  delete(stream) {
    this.statuses.delete(stream);
  }
}

/**
 * Tracks whether a stream has an execution directory available.
 */
class ExecutionIdAvailability {
  constructor() {
    this.availability = new Map();
  }

  setAvailable(stream, hasExecutionId) {
    if (!stream) {
      console.error('ExecutionIdAvailability.setAvailable: stream is required');
      return;
    }
    this.availability.set(stream, Boolean(hasExecutionId));
  }

  hasExecutionId(stream) {
    return this.availability.get(stream) ?? false;
  }

  delete(stream) {
    if (!stream) {
      return;
    }
    this.availability.delete(stream);
  }

  clear() {
    this.availability.clear();
  }
}

/**
 * Manages progress view state and handles persistence.
 */
export class ProgressViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.activeStream = '';
    this.agentTypeFilter = 'all';
    this.pendingFilterUpdate = false;
    this.currentGroupId = null;
    this.approvalBypassActive = false;
    this.activeRunId = null;
    this.activeSessionKind = 'workflow';
    this.runInstructions = new Map();
    this.runFiles = new Map();
    this.runMissingOutputs = new Map();
    this.runUsage = new Map();
    this.pendingInstruction = null;

    // Initialize managers
    this.taskGroups = new TaskGroups();
    this.toggleStates = new ToggleStates(() => this.saveToggleStates());
    this.streamStatuses = new StreamStatuses();
    this.executionIdAvailability = new ExecutionIdAvailability();
  }

  setExecutionIdAvailable(stream, hasExecutionId) {
    this.executionIdAvailability.setAvailable(stream, hasExecutionId);
  }

  hasExecutionId(stream) {
    return this.executionIdAvailability.hasExecutionId(stream);
  }

  clearExecutionIdAvailability(stream) {
    this.executionIdAvailability.delete(stream);
  }

  resetExecutionIdAvailability() {
    this.executionIdAvailability.clear();
  }

  /** Load saved state from VS Code storage. */
  load() {
    const previous = this.stateManager.getState();
    if (Array.isArray(previous?.groupToggleStates)) {
      this.toggleStates.load(previous.groupToggleStates);
    }
  }

  /** Persist the current group toggle states. */
  saveToggleStates() {
    try {
      this.stateManager.update({
        groupToggleStates: this.toggleStates.entries(),
      });
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }

  setActiveRunId(runId) {
    this.activeRunId = runId || null;
  }

  getActiveRunId() {
    return this.activeRunId;
  }

  getFallbackRunId() {
    if (this.activeRunId) {
      return this.activeRunId;
    }

    for (const map of [
      this.runFiles,
      this.runUsage,
      this.runInstructions,
      this.runMissingOutputs,
    ]) {
      for (const runId of map.keys()) {
        if (runId) {
          return runId;
        }
      }
    }

    return null;
  }

  getPendingInstruction() {
    return this.pendingInstruction;
  }

  setPendingInstruction(instruction) {
    if (!instruction || typeof instruction.text !== 'string') {
      this.pendingInstruction = null;
      return;
    }

    const text = instruction.text.trim();
    if (!text) {
      this.pendingInstruction = null;
      return;
    }

    this.pendingInstruction = {
      text,
      metadata: instruction.metadata,
    };
  }

  consumePendingInstruction() {
    const pending = this.pendingInstruction;
    this.pendingInstruction = null;
    return pending;
  }

  clearPendingInstruction() {
    this.pendingInstruction = null;
  }

  setRunInstruction(runId, instruction) {
    if (!runId) {
      return;
    }
    const text = instruction?.text ?? '';
    if (typeof text !== 'string' || !text.trim()) {
      this.runInstructions.delete(runId);
      return;
    }

    const normalizedText = text.trim();

    const normalizedInstruction = {
      text: normalizedText,
      metadata: instruction?.metadata,
    };
    this.runInstructions.set(runId, normalizedInstruction);
    if (
      this.pendingInstruction &&
      this.pendingInstruction.text === normalizedText
    ) {
      this.pendingInstruction = null;
    }
  }

  clearRunInstruction(runId) {
    if (!runId) {
      return;
    }
    this.runInstructions.delete(runId);
  }

  getRunInstruction(runId) {
    if (!runId) {
      return null;
    }
    return this.runInstructions.get(runId) || null;
  }

  clearRunInstructions() {
    this.runInstructions.clear();
    this.clearPendingInstruction();
  }

  setRunFiles(runId, filesByRound) {
    if (!runId) {
      return;
    }
    this.runFiles.set(runId, filesByRound || {});
  }

  getRunFiles(runId) {
    if (!runId) {
      return null;
    }
    return this.runFiles.get(runId) || null;
  }

  clearRunFiles() {
    this.runFiles.clear();
  }

  deleteRunFiles(runId) {
    if (!runId) {
      return;
    }
    this.runFiles.delete(runId);
  }

  setRunMissingOutputs(runId, filesByRound) {
    if (!runId) {
      return;
    }
    this.runMissingOutputs.set(runId, filesByRound || {});
  }

  getRunMissingOutputs(runId) {
    if (!runId) {
      return null;
    }
    return this.runMissingOutputs.get(runId) || null;
  }

  clearRunMissingOutputs() {
    this.runMissingOutputs.clear();
  }

  setRunUsage(runId, usage) {
    if (!runId) {
      return;
    }
    const normalized = {
      inputTokens: Number(usage?.inputTokens) || 0,
      outputTokens: Number(usage?.outputTokens) || 0,
      cost: Number(usage?.cost) || 0,
    };
    if (
      normalized.inputTokens === 0 &&
      normalized.outputTokens === 0 &&
      normalized.cost === 0
    ) {
      this.runUsage.delete(runId);
      return;
    }
    this.runUsage.set(runId, normalized);
  }

  getRunUsage(runId) {
    if (!runId) {
      return null;
    }
    return this.runUsage.get(runId) || null;
  }

  getAllRunUsage() {
    return new Map(this.runUsage);
  }

  clearRunUsage() {
    this.runUsage.clear();
  }

  deleteRunMissingOutputs(runId) {
    if (!runId) {
      return;
    }
    this.runMissingOutputs.delete(runId);
  }
}

export const progressViewState = new ProgressViewState();
