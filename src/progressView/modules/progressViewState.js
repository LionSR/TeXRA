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
    this.activeSessionKind = 'workflow';
    this.pendingInstructions = new Map();

    this.activeRunIds = new Map();
    this.runInstructions = new Map();
    this.runFiles = new Map();
    this.runMissingOutputs = new Map();
    this.runUsage = new Map();

    // Initialize managers
    this.taskGroups = new TaskGroups();
    this.toggleStates = new ToggleStates(() => this.saveToggleStates());
    this.streamStatuses = new StreamStatuses();
    this.executionIdAvailability = new ExecutionIdAvailability();
  }

  _resolveStreamId(streamId) {
    if (streamId !== undefined && streamId !== null) {
      return streamId;
    }

    if (this.activeStream !== undefined && this.activeStream !== null) {
      return this.activeStream;
    }

    return null;
  }

  _getStreamMap(container, streamId, createIfMissing = false) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return null;
    }

    let streamMap = container.get(targetStream) || null;
    if (!streamMap && createIfMissing) {
      streamMap = new Map();
      container.set(targetStream, streamMap);
    }
    return streamMap;
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

  setActiveRunId(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return;
    }

    if (runId) {
      this.activeRunIds.set(targetStream, runId);
    } else {
      this.activeRunIds.delete(targetStream);
    }
  }

  getActiveRunId(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return null;
    }
    return this.activeRunIds.get(targetStream) || null;
  }

  clearActiveRun(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return;
    }
    this.activeRunIds.delete(targetStream);
  }

  clearAllActiveRuns() {
    this.activeRunIds.clear();
  }

  resolveActiveRunId(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return null;
    }

    const current = this.getActiveRunId(targetStream);
    if (current) {
      return current;
    }

    const candidates = this._collectRunCandidates(targetStream);
    if (candidates.size === 1) {
      const [only] = Array.from(candidates);
      if (only) {
        this.setActiveRunId(targetStream, only);
        return only;
      }
    }

    const latest = this._findLatestRunId(targetStream);
    if (latest) {
      this.setActiveRunId(targetStream, latest);
      return latest;
    }

    return null;
  }

  _collectRunCandidates(streamId) {
    const candidates = new Set();

    const instructionRuns = this.runInstructions.get(streamId);
    if (instructionRuns) {
      for (const runId of instructionRuns.keys()) {
        if (runId) {
          candidates.add(runId);
        }
      }
    }

    const fileRuns = this.runFiles.get(streamId);
    if (fileRuns) {
      for (const runId of fileRuns.keys()) {
        if (runId) {
          candidates.add(runId);
        }
      }
    }

    const missingRuns = this.runMissingOutputs.get(streamId);
    if (missingRuns) {
      for (const runId of missingRuns.keys()) {
        if (runId) {
          candidates.add(runId);
        }
      }
    }

    const usageRuns = this.runUsage.get(streamId);
    if (usageRuns) {
      for (const runId of usageRuns.keys()) {
        if (runId) {
          candidates.add(runId);
        }
      }
    }

    const groups = this.taskGroups.getGroupMap();
    for (const group of groups.values()) {
      if (group && !group.parentGroupId) {
        candidates.add(group.id);
      }
    }

    return candidates;
  }

  _findLatestRunId(streamId) {
    const groups = this.taskGroups.getGroupMap();
    const rootGroups = [];
    for (const group of groups.values()) {
      if (group && !group.parentGroupId) {
        rootGroups.push(group);
      }
    }

    if (rootGroups.length === 0) {
      const usageRuns = this.runUsage.get(streamId);
      if (usageRuns && usageRuns.size > 0) {
        return Array.from(usageRuns.keys())[usageRuns.size - 1] || null;
      }
      return null;
    }

    rootGroups.sort((a, b) => {
      const aTime = typeof a.startTime === 'number' ? a.startTime : 0;
      const bTime = typeof b.startTime === 'number' ? b.startTime : 0;
      return aTime - bTime;
    });

    const latest = rootGroups[rootGroups.length - 1];
    return latest?.id || null;
  }

  setPendingInstruction(streamId, instruction) {
    if (
      streamId === undefined ||
      streamId === null ||
      !instruction ||
      !instruction.text
    ) {
      return;
    }

    const text = instruction.text.trim();
    if (!text) {
      this.pendingInstructions.delete(streamId);
      return;
    }

    this.pendingInstructions.set(streamId, {
      text,
      metadata: instruction.metadata,
    });
  }

  takePendingInstruction(streamId) {
    if (streamId === undefined || streamId === null) {
      return null;
    }
    const pending = this.pendingInstructions.get(streamId) || null;
    if (pending) {
      this.pendingInstructions.delete(streamId);
    }
    return pending;
  }

  clearPendingInstruction(streamId) {
    if (streamId === undefined || streamId === null) {
      return;
    }
    this.pendingInstructions.delete(streamId);
  }

  clearAllPendingInstructions() {
    this.pendingInstructions.clear();
  }

  setRunInstruction(streamId, runId, instruction) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }

    const text = instruction?.text ?? '';
    if (typeof text !== 'string' || !text.trim()) {
      this.clearRunInstruction(targetStream, runId);
      return;
    }

    const streamMap = this._getStreamMap(
      this.runInstructions,
      targetStream,
      true,
    );
    streamMap.set(runId, {
      text: text.trim(),
      metadata: instruction?.metadata,
    });
  }

  clearRunInstruction(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    const streamMap = this.runInstructions.get(targetStream);
    if (!streamMap) {
      return;
    }
    streamMap.delete(runId);
    if (streamMap.size === 0) {
      this.runInstructions.delete(targetStream);
    }
  }

  getRunInstruction(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return null;
    }
    const streamMap = this.runInstructions.get(targetStream);
    if (!streamMap) {
      return null;
    }
    return streamMap.get(runId) || null;
  }

  clearRunInstructions(streamId) {
    if (streamId !== undefined && streamId !== null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runInstructions.delete(targetStream);
      this.clearPendingInstruction(targetStream);
      return;
    }

    this.runInstructions.clear();
    this.clearAllPendingInstructions();
  }

  setRunFiles(streamId, runId, filesByRound) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    const streamMap = this._getStreamMap(this.runFiles, targetStream, true);
    streamMap.set(runId, filesByRound || {});
  }

  getRunFiles(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return null;
    }
    const streamMap = this.runFiles.get(targetStream);
    if (!streamMap) {
      return null;
    }
    return streamMap.get(runId) || null;
  }

  clearRunFiles(streamId) {
    if (streamId !== undefined && streamId !== null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runFiles.delete(targetStream);
      return;
    }

    this.runFiles.clear();
  }

  deleteRunFiles(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    const streamMap = this.runFiles.get(targetStream);
    if (!streamMap) {
      return;
    }
    streamMap.delete(runId);
    if (streamMap.size === 0) {
      this.runFiles.delete(targetStream);
    }
  }

  setRunMissingOutputs(streamId, runId, filesByRound) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    const streamMap = this._getStreamMap(
      this.runMissingOutputs,
      targetStream,
      true,
    );
    streamMap.set(runId, filesByRound || {});
  }

  getRunMissingOutputs(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return null;
    }
    const streamMap = this.runMissingOutputs.get(targetStream);
    if (!streamMap) {
      return null;
    }
    return streamMap.get(runId) || null;
  }

  clearRunMissingOutputs(streamId) {
    if (streamId !== undefined && streamId !== null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runMissingOutputs.delete(targetStream);
      return;
    }

    this.runMissingOutputs.clear();
  }

  setRunUsage(streamId, runId, usage) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
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
      this.clearRunUsage(targetStream, runId);
      return;
    }
    const streamMap = this._getStreamMap(this.runUsage, targetStream, true);
    streamMap.set(runId, normalized);
  }

  getRunUsage(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return null;
    }
    const streamMap = this.runUsage.get(targetStream);
    if (!streamMap) {
      return null;
    }
    return streamMap.get(runId) || null;
  }

  clearRunUsage(streamId, runId) {
    if (streamId !== undefined && streamId !== null && runId) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      const streamMap = this.runUsage.get(targetStream);
      if (!streamMap) {
        return;
      }
      streamMap.delete(runId);
      if (streamMap.size === 0) {
        this.runUsage.delete(targetStream);
      }
      return;
    }

    if (streamId !== undefined && streamId !== null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runUsage.delete(targetStream);
      return;
    }

    this.runUsage.clear();
  }

  deleteRunMissingOutputs(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    const streamMap = this.runMissingOutputs.get(targetStream);
    if (!streamMap) {
      return;
    }
    streamMap.delete(runId);
    if (streamMap.size === 0) {
      this.runMissingOutputs.delete(targetStream);
    }
  }
}

export const progressViewState = new ProgressViewState();
