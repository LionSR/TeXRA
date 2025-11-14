// Local imports - progress view
// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Manages task groups in the progress view.
 */
class TaskGroups {
  constructor() {
    this.groups = new Map();
    this.childrenByParent = new Map();
    this.parentByChild = new Map();
  }

  get(id) {
    return this.groups.get(id) ?? null;
  }

  set(id, group) {
    if (!id || !group) {
      return;
    }

    const previousParentId = this.parentByChild.get(id);
    const nextParentId = group.parentGroupId || null;

    if (previousParentId && previousParentId !== nextParentId) {
      this._removeChild(previousParentId, id);
    }

    this.groups.set(id, group);

    if (nextParentId) {
      this._addChild(nextParentId, id);
    } else {
      this.parentByChild.delete(id);
    }
  }

  delete(id) {
    if (!id) {
      return;
    }

    const parentId = this.parentByChild.get(id);
    if (parentId) {
      this._removeChild(parentId, id);
    } else {
      this.parentByChild.delete(id);
    }

    const children = this.childrenByParent.get(id);
    if (children) {
      for (const childId of children) {
        if (this.parentByChild.get(childId) === id) {
          this.parentByChild.delete(childId);
        }
      }
      this.childrenByParent.delete(id);
    }

    this.groups.delete(id);
  }

  getGroupMap() {
    return this.groups;
  }

  clear() {
    this.groups.clear();
    this.childrenByParent.clear();
    this.parentByChild.clear();
  }

  /**
   * Update an existing log group with a structured payload.
   * @param {{ groupId: string, updates?: Object }} payload
   */
  update(payload) {
    if (!payload) {
      return;
    }

    const { groupId, updates = {} } = payload;
    const group = this.groups.get(groupId);
    if (!group) {
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

    this.set(groupId, group);
  }

  getChildIds(parentId) {
    const children = this.childrenByParent.get(parentId);
    if (!children) {
      return [];
    }

    return Array.from(children);
  }

  _addChild(parentId, childId) {
    let children = this.childrenByParent.get(parentId);
    if (!children) {
      children = new Set();
      this.childrenByParent.set(parentId, children);
    }
    children.add(childId);
    this.parentByChild.set(childId, parentId);
  }

  _removeChild(parentId, childId) {
    const children = this.childrenByParent.get(parentId);
    if (!children) {
      return;
    }

    children.delete(childId);
    if (this.parentByChild.get(childId) === parentId) {
      this.parentByChild.delete(childId);
    }
    if (children.size === 0) {
      this.childrenByParent.delete(parentId);
    }
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
    this.states.set(id, collapsed);
    this.saveCallback?.();
  }

  get(id) {
    return this.states.get(id);
  }

  clearSelection(ids) {
    if (!Array.isArray(ids)) {
      return;
    }
    ids.forEach((id) => {
      if (id) {
        this.states.delete(id);
      }
    });
    this.saveCallback?.();
  }

  clearAll() {
    this.states.clear();
    this.saveCallback?.();
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
      return;
    }
    if (!status || status === 'ready') {
      this.statuses.delete(stream);
      return;
    }
    this.statuses.set(stream, status);
  }

  delete(stream) {
    this.statuses.delete(stream);
  }
}

class RunScopedStore {
  constructor(resolveStreamId) {
    this._resolveStreamId = resolveStreamId;
    this._store = new Map();
  }

  _resolve(streamId) {
    return this._resolveStreamId(streamId);
  }

  _getStreamMap(streamId, createIfMissing) {
    const targetStream = this._resolve(streamId);
    if (targetStream == null) {
      return { targetStream: null, streamMap: null };
    }

    let streamMap = this._store.get(targetStream) || null;
    if (!streamMap && createIfMissing) {
      streamMap = new Map();
      this._store.set(targetStream, streamMap);
    }

    return { targetStream, streamMap };
  }

  getStreamMap(streamId) {
    return this._getStreamMap(streamId, false).streamMap;
  }

  set(streamId, runId, value) {
    if (!runId) {
      return;
    }
    const { streamMap } = this._getStreamMap(streamId, true);
    if (streamMap) {
      streamMap.set(runId, value);
    }
  }

  get(streamId, runId) {
    if (!runId) {
      return null;
    }
    const { streamMap } = this._getStreamMap(streamId, false);
    if (!streamMap) {
      return null;
    }
    return streamMap.get(runId) ?? null;
  }

  delete(streamId, runId) {
    if (!runId) {
      return;
    }
    const { targetStream, streamMap } = this._getStreamMap(streamId, false);
    if (!streamMap) {
      return;
    }
    streamMap.delete(runId);
    if (streamMap.size === 0 && targetStream != null) {
      this._store.delete(targetStream);
    }
  }

  clear(streamId) {
    if (streamId !== undefined && streamId !== null) {
      const targetStream = this._resolve(streamId);
      if (targetStream == null) {
        return;
      }
      this._store.delete(targetStream);
      return;
    }

    this._store.clear();
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
    const streamResolver = (streamId) => this._resolveStreamId(streamId);
    this.runInstructions = new RunScopedStore(streamResolver);
    this.runFiles = new RunScopedStore(streamResolver);
    this.runMissingOutputs = new RunScopedStore(streamResolver);
    this.runUsage = new RunScopedStore(streamResolver);

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

    const instructionRuns = this.runInstructions.getStreamMap(streamId);
    if (instructionRuns) {
      for (const runId of instructionRuns.keys()) {
        if (runId) {
          candidates.add(runId);
        }
      }
    }

    const fileRuns = this.runFiles.getStreamMap(streamId);
    if (fileRuns) {
      for (const runId of fileRuns.keys()) {
        if (runId) {
          candidates.add(runId);
        }
      }
    }

    const missingRuns = this.runMissingOutputs.getStreamMap(streamId);
    if (missingRuns) {
      for (const runId of missingRuns.keys()) {
        if (runId) {
          candidates.add(runId);
        }
      }
    }

    const usageRuns = this.runUsage.getStreamMap(streamId);
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
      const usageRuns = this.runUsage.getStreamMap(streamId);
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

    this.runInstructions.set(targetStream, runId, {
      text: text.trim(),
      metadata: instruction?.metadata,
    });
  }

  clearRunInstruction(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    this.runInstructions.delete(targetStream, runId);
  }

  getRunInstruction(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return null;
    }
    return this.runInstructions.get(targetStream, runId);
  }

  clearRunInstructions(streamId) {
    if (streamId !== undefined && streamId !== null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runInstructions.clear(targetStream);
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
    this.runFiles.set(targetStream, runId, filesByRound || {});
  }

  getRunFiles(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return null;
    }
    return this.runFiles.get(targetStream, runId);
  }

  clearRunFiles(streamId) {
    this.runFiles.clear(streamId);
  }

  deleteRunFiles(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    this.runFiles.delete(targetStream, runId);
  }

  setRunMissingOutputs(streamId, runId, filesByRound) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    this.runMissingOutputs.set(targetStream, runId, filesByRound || {});
  }

  getRunMissingOutputs(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return null;
    }
    return this.runMissingOutputs.get(targetStream, runId);
  }

  clearRunMissingOutputs(streamId) {
    this.runMissingOutputs.clear(streamId);
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
    this.runUsage.set(targetStream, runId, normalized);
  }

  getRunUsage(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return null;
    }
    return this.runUsage.get(targetStream, runId);
  }

  clearRunUsage(streamId, runId) {
    if (streamId !== undefined && streamId !== null && runId) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runUsage.delete(targetStream, runId);
      return;
    }

    if (streamId !== undefined && streamId !== null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runUsage.clear(targetStream);
      return;
    }

    this.runUsage.clear();
  }

  deleteRunMissingOutputs(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    this.runMissingOutputs.delete(targetStream, runId);
  }
}

export const progressViewState = new ProgressViewState();
