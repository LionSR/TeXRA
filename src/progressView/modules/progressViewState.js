// Local imports - progress view
// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';
import { ToggleStateStore } from '@common/ToggleStateStore.js';

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
   * Payload uses flat structure: { id, status, endTime } matching UpdateTaskGroupPayload.
   * @param {{ id: string, status?: string, endTime?: number }} payload
   */
  update(payload) {
    if (!payload) {
      return;
    }

    const { id, status, endTime } = payload;
    const group = this.groups.get(id);
    if (!group) {
      return;
    }

    if (status) {
      group.status = status;
    }
    if (endTime !== undefined && endTime !== null) {
      group.endTime = endTime;
    }

    this.set(id, group);
  }

  getChildIds(parentId) {
    const children = this.childrenByParent.get(parentId);
    if (!children) {
      return [];
    }

    return [...children];
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

class RunScopedMap {
  constructor(resolveStreamId) {
    this._resolveStreamId = resolveStreamId;
    this._data = new Map();
  }

  set(streamId, runId, value) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }

    let runs = this._data.get(targetStream);
    if (!runs) {
      runs = new Map();
      this._data.set(targetStream, runs);
    }
    runs.set(runId, value);
  }

  get(streamId, runId) {
    if (!runId) {
      return null;
    }
    const runs = this.getStreamMap(streamId);
    return runs?.get(runId) ?? null;
  }

  delete(streamId, runId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    const runs = this._data.get(targetStream);
    if (!runs) {
      return;
    }
    runs.delete(runId);
    if (runs.size === 0) {
      this._data.delete(targetStream);
    }
  }

  clearStream(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return;
    }
    this._data.delete(targetStream);
  }

  clearAll() {
    this._data.clear();
  }

  getStreamMap(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return null;
    }
    return this._data.get(targetStream) ?? null;
  }

  streamEntries() {
    return this._data.entries();
  }
}

/**
 * Manages progress view state and handles persistence.
 */
export class ProgressViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.activeStream = '';
    this.streams = new Set();
    this.agentTypeFilter = 'all';
    this.pendingFilterUpdate = false;
    this.currentGroupId = null;
    this.approvalBypassActive = false;
    this.activeSessionKind = 'workflow';
    this.pendingInstructions = new Map();

    this.activeRunIds = new Map();
    const streamResolver = this._resolveStreamId.bind(this);
    this.runInstructions = new RunScopedMap(streamResolver);
    this.runFiles = new RunScopedMap(streamResolver);
    this.runMissingOutputs = new RunScopedMap(streamResolver);
    this.runUsage = new RunScopedMap(streamResolver);
    // Context state (input tokens, context window) per stream
    this.contextState = new Map();
    // Todo storage by stream ID
    this.streamTodos = new Map();

    // Initialize managers
    this.taskGroups = new TaskGroups();
    this.toggleStates = new ToggleStateStore(this.saveToggleStates.bind(this));
    this.streamStatuses = new StreamStatuses();
    this.executionIdAvailability = new ExecutionIdAvailability();
  }

  _resolveStreamId(streamId) {
    if (streamId != null) {
      return streamId;
    }

    if (this.activeStream != null) {
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

  setStreams(streams) {
    this.streams = new Set(streams?.filter(Boolean));
  }

  removeStream(stream) {
    if (!stream) {
      return;
    }
    this.streams.delete(stream);
  }

  clearStreams() {
    this.streams.clear();
  }

  hasStreams() {
    return this.streams.size > 0;
  }

  /** Persist the current group toggle states. */
  saveToggleStates() {
    try {
      this.stateManager.update({
        groupToggleStates: this.toggleStates.entries(),
      });
    } catch (e) {
      console.error('[ProgressViewState] Failed to save toggle states:', e);
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
      const [only] = candidates;
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
        let latestRunId = null;
        for (const runId of usageRuns.keys()) {
          latestRunId = runId;
        }
        return latestRunId;
      }
      return null;
    }

    rootGroups.sort((a, b) => {
      const aTime = typeof a.startTime === 'number' ? a.startTime : 0;
      const bTime = typeof b.startTime === 'number' ? b.startTime : 0;
      return aTime - bTime;
    });

    const latest = rootGroups.at(-1);
    return latest?.id ?? null;
  }

  setPendingInstruction(streamId, instruction) {
    if (streamId == null || !instruction || !instruction.text) {
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
    if (streamId == null) {
      return null;
    }
    const pending = this.pendingInstructions.get(streamId) ?? null;
    if (pending) {
      this.pendingInstructions.delete(streamId);
    }
    return pending;
  }

  clearPendingInstruction(streamId) {
    if (streamId == null) {
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
    if (!runId) {
      return;
    }
    this.runInstructions.delete(streamId, runId);
  }

  getRunInstruction(streamId, runId) {
    return this.runInstructions.get(streamId, runId);
  }

  clearRunInstructions(streamId) {
    if (streamId != null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runInstructions.clearStream(targetStream);
      this.clearPendingInstruction(targetStream);
      return;
    }

    this.runInstructions.clearAll();
    this.clearAllPendingInstructions();
  }

  setRunFiles(streamId, runId, filesByRound) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    this.runFiles.set(targetStream, runId, filesByRound ?? {});
  }

  getRunFiles(streamId, runId) {
    return this.runFiles.get(streamId, runId);
  }

  clearRunFiles(streamId) {
    if (streamId != null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runFiles.clearStream(targetStream);
      return;
    }

    this.runFiles.clearAll();
  }

  deleteRunFiles(streamId, runId) {
    this.runFiles.delete(streamId, runId);
  }

  setRunMissingOutputs(streamId, runId, filesByRound) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    this.runMissingOutputs.set(targetStream, runId, filesByRound ?? {});
  }

  getRunMissingOutputs(streamId, runId) {
    return this.runMissingOutputs.get(streamId, runId);
  }

  clearRunMissingOutputs(streamId) {
    if (streamId != null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream == null) {
        return;
      }
      this.runMissingOutputs.clearStream(targetStream);
      return;
    }

    this.runMissingOutputs.clearAll();
  }

  setRunUsage(streamId, runId, usage) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !runId) {
      return;
    }
    // SET semantics: backend sends accumulated values, we store directly
    // (no accumulation here - backend handles accumulation in UsageStatsManager)
    // Use ?? (nullish coalescing) not || to preserve 0 and NaN as intentional values
    const normalized = {
      inputTokens: Number(usage?.inputTokens ?? 0),
      outputTokens: Number(usage?.outputTokens ?? 0),
      cost: Number(usage?.cost ?? 0),
      cacheReadInputTokens: Number(usage?.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: Number(usage?.cacheCreationInputTokens ?? 0),
    };
    if (
      normalized.inputTokens === 0 &&
      normalized.outputTokens === 0 &&
      normalized.cost === 0
    ) {
      // Empty usage means nothing to store.
      // Note: We only check input/output/cost, not cache tokens separately.
      // Cost is calculated upstream and already includes cache creation charges
      // (Anthropic: 1.25x input price), so cost=0 implies no cache creation billing.
      return;
    }
    this.runUsage.set(targetStream, runId, normalized);
  }

  getRunUsage(streamId, runId) {
    return this.runUsage.get(streamId, runId);
  }

  clearRunUsage(streamId, runId) {
    if (runId) {
      this.runUsage.delete(streamId, runId);
      return;
    }

    if (streamId != null) {
      this.runUsage.clearStream(streamId);
      return;
    }

    this.runUsage.clearAll();
  }

  /**
   * Set context state for a stream (input tokens vs context window).
   * @param {string} streamId - The stream ID
   * @param {{ inputTokens: number, contextWindow: number, utilizationPercent: number }} state
   */
  setContextState(streamId, state) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null || !state) {
      return;
    }
    this.contextState.set(targetStream, {
      inputTokens: state.inputTokens ?? 0,
      contextWindow: state.contextWindow ?? 0,
      utilizationPercent: state.utilizationPercent ?? 0,
    });
  }

  /**
   * Get context state for a stream.
   * @param {string} streamId - The stream ID
   * @returns {{ inputTokens: number, contextWindow: number, utilizationPercent: number } | null}
   */
  getContextState(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return null;
    }
    return this.contextState.get(targetStream) || null;
  }

  /**
   * Clear context state for a stream.
   * @param {string} streamId - The stream ID
   */
  clearContextState(streamId) {
    if (streamId != null) {
      const targetStream = this._resolveStreamId(streamId);
      if (targetStream != null) {
        this.contextState.delete(targetStream);
      }
      return;
    }
    this.contextState.clear();
  }

  deleteRunMissingOutputs(streamId, runId) {
    this.runMissingOutputs.delete(streamId, runId);
  }

  /**
   * Set todos for a stream.
   * @param {string} streamId - The stream ID
   * @param {Array<{content: string, status: string, activeForm: string}>} todos - The todo items
   */
  setTodos(streamId, todos) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return;
    }
    this.streamTodos.set(targetStream, todos ?? []);
  }

  /**
   * Get todos for a stream.
   * @param {string} streamId - The stream ID
   * @returns {Array<{content: string, status: string, activeForm: string}>|null}
   */
  getTodos(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return null;
    }
    return this.streamTodos.get(targetStream) || null;
  }

  /**
   * Clear todos for a specific stream.
   * @param {string} streamId - The stream ID
   */
  clearTodos(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return;
    }
    this.streamTodos.delete(targetStream);
  }

  /**
   * Clear all todos across all streams.
   */
  clearAllTodos() {
    this.streamTodos.clear();
  }
}

export const progressViewState = new ProgressViewState();
