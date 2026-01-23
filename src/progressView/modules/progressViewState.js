// Local imports - progress view
// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';
import { ToggleStateStore } from '@common/ToggleStateStore.js';
import { StreamScopedMap } from '@common/StreamScopedMap.js';

/**
 * Manages task groups in the progress view with parent-child relationships.
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
    if (!id || !group) return;

    const previousParentId = this.parentByChild.get(id);
    const nextParentId = group.parentGroupId || null;

    // Update parent-child links if parent changed
    if (previousParentId !== nextParentId) {
      if (previousParentId) this._unlinkChild(previousParentId, id);
      if (nextParentId) this._linkChild(nextParentId, id);
      else this.parentByChild.delete(id);
    }

    this.groups.set(id, group);
  }

  delete(id) {
    if (!id) return;

    // Remove from parent's children
    const parentId = this.parentByChild.get(id);
    if (parentId) this._unlinkChild(parentId, id);
    this.parentByChild.delete(id);

    // Orphan all children (clear their parent reference)
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
   * Update an existing group's status and endTime.
   */
  update(payload) {
    if (!payload?.id) return;

    const group = this.groups.get(payload.id);
    if (!group) return;

    if (payload.status) group.status = payload.status;
    if (payload.endTime != null) group.endTime = payload.endTime;

    this.set(payload.id, group);
  }

  getChildIds(parentId) {
    return [...(this.childrenByParent.get(parentId) ?? [])];
  }

  /** Get or create children set for a parent */
  _getChildrenSet(parentId) {
    let children = this.childrenByParent.get(parentId);
    if (!children) {
      children = new Set();
      this.childrenByParent.set(parentId, children);
    }
    return children;
  }

  _linkChild(parentId, childId) {
    this._getChildrenSet(parentId).add(childId);
    this.parentByChild.set(childId, parentId);
  }

  _unlinkChild(parentId, childId) {
    const children = this.childrenByParent.get(parentId);
    if (!children) return;

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
 * Stores only non-ready statuses; 'ready' and falsy values trigger deletion.
 * Extends Map directly to reduce boilerplate while adding semantic set logic.
 */
class StreamStatuses extends Map {
  set(stream, status) {
    if (!stream) return this;
    // Only store meaningful statuses; 'ready' is the default state
    if (!status || status === 'ready') {
      this.delete(stream);
    } else {
      super.set(stream, status);
    }
    return this;
  }
}

class RunScopedMap {
  constructor(resolveStreamId) {
    this._resolveStreamId = resolveStreamId;
    this._data = new Map();
  }

  /** Resolve stream and get its run map, optionally creating if missing */
  _getOrCreateStreamMap(streamId, runId, create = false) {
    const stream = runId ? this._resolveStreamId(streamId) : null;
    if (!stream) return null;

    let runs = this._data.get(stream);
    if (!runs && create) {
      runs = new Map();
      this._data.set(stream, runs);
    }
    return runs ?? null;
  }

  set(streamId, runId, value) {
    const runs = this._getOrCreateStreamMap(streamId, runId, true);
    if (runs) runs.set(runId, value);
  }

  get(streamId, runId) {
    if (!runId) return null;
    return this._getOrCreateStreamMap(streamId, runId)?.get(runId) ?? null;
  }

  delete(streamId, runId) {
    const stream = runId ? this._resolveStreamId(streamId) : null;
    if (!stream) return;

    const runs = this._data.get(stream);
    if (!runs) return;

    runs.delete(runId);
    if (runs.size === 0) {
      this._data.delete(stream);
    }
  }

  clearStream(streamId) {
    const stream = this._resolveStreamId(streamId);
    if (stream) this._data.delete(stream);
  }

  clearAll() {
    this._data.clear();
  }

  getStreamMap(streamId) {
    const stream = this._resolveStreamId(streamId);
    return stream ? (this._data.get(stream) ?? null) : null;
  }
}

/**
 * Manages progress view state and handles persistence.
 */
export class ProgressViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this.activeStream = '';
    /**
     * Tracks the stream that was last rendered to the DOM.
     * Used by frontend to detect stream switches independently.
     * This is the SINGLE SOURCE OF TRUTH for stream switch detection.
     */
    this.lastRenderedStream = '';
    this.streams = new Set();
    this.agentCategoryFilter = 'all';
    this.pendingFilterUpdate = false;
    this.currentGroupId = null;
    this.activeAgentCategory = 'workflow';
    this.pendingInstructions = new Map();
    /** Per-stream YOLO mode state */
    this.approvalBypassByStream = new Map();

    this.activeRunIds = new Map();
    const streamResolver = this._resolveStreamId.bind(this);
    this.runInstructions = new RunScopedMap(streamResolver);
    this.runFiles = new RunScopedMap(streamResolver);
    this.runMissingOutputs = new RunScopedMap(streamResolver);
    this.runUsage = new RunScopedMap(streamResolver);
    // Stream-scoped state using shared utility
    // Context state (input tokens, context window) per stream
    this.contextState = new StreamScopedMap(streamResolver);
    // Todo storage by stream ID
    this.streamTodos = new StreamScopedMap(streamResolver);
    // Queued follow-ups storage by stream ID
    this.streamQueuedFollowUps = new StreamScopedMap(streamResolver);
    // Follow-up textarea text storage by stream ID (persists draft text per tab)
    this.streamFollowUpText = new StreamScopedMap(streamResolver);
    // Followup section mode per stream (chat/workflow/merge)
    this.streamFollowupMode = new StreamScopedMap(streamResolver);

    // Initialize managers
    this.taskGroups = new TaskGroups();
    this.toggleStates = new ToggleStateStore(this.saveToggleStates.bind(this));
    this.streamStatuses = new StreamStatuses();
    this._executionIdAvailability = new Map();
  }

  _resolveStreamId(streamId) {
    return streamId || this.activeStream || null;
  }

  setExecutionIdAvailable(stream, hasExecutionId) {
    this._executionIdAvailability.set(stream, Boolean(hasExecutionId));
  }

  hasExecutionId(stream) {
    return this._executionIdAvailability.get(stream) ?? false;
  }

  clearExecutionIdAvailability(stream) {
    if (stream) {
      this._executionIdAvailability.delete(stream);
    }
  }

  resetExecutionIdAvailability() {
    this._executionIdAvailability.clear();
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

    // Return current if already set
    const current = this.getActiveRunId(targetStream);
    if (current) {
      return current;
    }

    // Resolve from candidates or latest, then cache and return
    const resolved = this._resolveRunIdFromCandidates(targetStream);
    if (resolved) {
      this.setActiveRunId(targetStream, resolved);
    }
    return resolved;
  }

  /**
   * Find the best run ID from candidates or latest.
   * @private
   */
  _resolveRunIdFromCandidates(streamId) {
    const candidates = this._collectRunCandidates(streamId);
    // Single candidate: use it directly; multiple: find latest
    if (candidates.size === 1) return [...candidates][0] ?? null;
    return this._findLatestRunId(streamId);
  }

  _collectRunCandidates(streamId) {
    const candidates = new Set();

    // Collect run IDs from all run-scoped maps
    const runMaps = [
      this.runInstructions,
      this.runFiles,
      this.runMissingOutputs,
      this.runUsage,
    ];
    for (const runMap of runMaps) {
      const keys = runMap.getStreamMap(streamId)?.keys();
      if (keys) {
        for (const runId of keys) if (runId) candidates.add(runId);
      }
    }

    // Add root task group IDs (groups without a parent)
    for (const group of this.taskGroups.getGroupMap().values()) {
      if (group && !group.parentGroupId) candidates.add(group.id);
    }

    return candidates;
  }

  _findLatestRunId(streamId) {
    const rootGroups = Array.from(
      this.taskGroups.getGroupMap().values(),
    ).filter((g) => g && !g.parentGroupId);

    if (rootGroups.length === 0) {
      // Fall back to last run ID from usage map
      const usageRuns = this.runUsage.getStreamMap(streamId);
      return usageRuns?.size > 0 ? Array.from(usageRuns.keys()).at(-1) : null;
    }

    // Return ID of the group with the latest start time
    const getTime = (g) => (typeof g.startTime === 'number' ? g.startTime : 0);
    return (
      rootGroups.sort((a, b) => getTime(a) - getTime(b)).at(-1)?.id ?? null
    );
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
      this.runInstructions.clearStream(streamId);
      this.clearPendingInstruction(streamId);
    } else {
      this.runInstructions.clearAll();
      this.clearAllPendingInstructions();
    }
  }

  setRunFiles(streamId, runId, filesByRound) {
    if (!runId) return;
    this.runFiles.set(streamId, runId, filesByRound ?? {});
  }

  getRunFiles(streamId, runId) {
    return this.runFiles.get(streamId, runId);
  }

  clearRunFiles(streamId) {
    if (streamId != null) {
      this.runFiles.clearStream(streamId);
    } else {
      this.runFiles.clearAll();
    }
  }

  deleteRunFiles(streamId, runId) {
    this.runFiles.delete(streamId, runId);
  }

  setRunMissingOutputs(streamId, runId, filesByRound) {
    if (!runId) return;
    this.runMissingOutputs.set(streamId, runId, filesByRound ?? {});
  }

  getRunMissingOutputs(streamId, runId) {
    return this.runMissingOutputs.get(streamId, runId);
  }

  clearRunMissingOutputs(streamId) {
    if (streamId != null) {
      this.runMissingOutputs.clearStream(streamId);
    } else {
      this.runMissingOutputs.clearAll();
    }
  }

  setRunUsage(streamId, runId, usage) {
    if (!runId) return;

    const num = (v) => Number(v ?? 0);
    const normalized = {
      inputTokens: num(usage?.inputTokens),
      outputTokens: num(usage?.outputTokens),
      cost: num(usage?.cost),
      cacheReadInputTokens: num(usage?.cacheReadInputTokens),
      cacheCreationInputTokens: num(usage?.cacheCreationInputTokens),
    };

    // Skip empty usage (all zeros indicates no actual API call)
    const hasUsage =
      normalized.inputTokens || normalized.outputTokens || normalized.cost;
    if (hasUsage) this.runUsage.set(streamId, runId, normalized);
  }

  getRunUsage(streamId, runId) {
    return this.runUsage.get(streamId, runId);
  }

  clearRunUsage(streamId, runId) {
    if (runId) {
      this.runUsage.delete(streamId, runId);
    } else if (streamId != null) {
      this.runUsage.clearStream(streamId);
    } else {
      this.runUsage.clearAll();
    }
  }

  /**
   * Set context state for a stream (input tokens vs context window).
   * @param {string} streamId - The stream ID
   * @param {{ inputTokens: number, contextWindow: number, utilizationPercent: number }} ctxState
   */
  setContextState(streamId, ctxState) {
    if (!ctxState) return;
    this.contextState.set(streamId, {
      inputTokens: ctxState.inputTokens ?? 0,
      contextWindow: ctxState.contextWindow ?? 0,
      utilizationPercent: ctxState.utilizationPercent ?? 0,
    });
  }

  /**
   * Get context state for a stream.
   * @param {string} streamId - The stream ID
   */
  getContextState(streamId) {
    return this.contextState.get(streamId) ?? null;
  }

  /**
   * Clear context state for a stream or all streams.
   * @param {string} [streamId] - The stream ID (clears all if omitted)
   */
  clearContextState(streamId) {
    if (streamId == null) return this.contextState.clear();
    this.contextState.delete(streamId);
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
    this.streamTodos.set(streamId, todos ?? []);
  }

  /**
   * Get todos for a stream.
   * @param {string} streamId - The stream ID
   * @returns {Array<{content: string, status: string, activeForm: string}>|null}
   */
  getTodos(streamId) {
    return this.streamTodos.get(streamId) || null;
  }

  /**
   * Clear todos for a specific stream.
   * @param {string} streamId - The stream ID
   */
  clearTodos(streamId) {
    this.streamTodos.delete(streamId);
  }

  /**
   * Clear all todos across all streams.
   */
  clearAllTodos() {
    this.streamTodos.clear();
  }

  /**
   * Set queued follow-ups for a stream.
   * @param {string} streamId - The stream ID
   * @param {string[]} messages - The queued message texts
   */
  setQueuedFollowUps(streamId, messages) {
    this.streamQueuedFollowUps.set(streamId, messages ?? []);
  }

  /**
   * Get queued follow-ups for a stream.
   * @param {string} streamId - The stream ID
   * @returns {string[]|null}
   */
  getQueuedFollowUps(streamId) {
    return this.streamQueuedFollowUps.get(streamId) || null;
  }

  /**
   * Clear queued follow-ups for a specific stream.
   * @param {string} streamId - The stream ID
   */
  clearQueuedFollowUps(streamId) {
    this.streamQueuedFollowUps.delete(streamId);
  }

  /**
   * Clear all queued follow-ups across all streams.
   */
  clearAllQueuedFollowUps() {
    this.streamQueuedFollowUps.clear();
  }

  /**
   * Set follow-up textarea text for a stream.
   * @param {string} streamId - The stream ID
   * @param {string} text - The textarea text
   */
  setFollowUpText(streamId, text) {
    if (text && text.trim()) {
      this.streamFollowUpText.set(streamId, text);
    } else {
      this.streamFollowUpText.delete(streamId);
    }
  }

  /**
   * Get follow-up textarea text for a stream.
   * @param {string} streamId - The stream ID
   * @returns {string} The textarea text or empty string
   */
  getFollowUpText(streamId) {
    return this.streamFollowUpText.get(streamId) || '';
  }

  /**
   * Clear follow-up textarea text for a specific stream.
   * @param {string} streamId - The stream ID
   */
  clearFollowUpText(streamId) {
    this.streamFollowUpText.delete(streamId);
  }

  /**
   * Clear all follow-up textarea text across all streams.
   */
  clearAllFollowUpText() {
    this.streamFollowUpText.clear();
  }

  /**
   * Set YOLO mode (approval bypass) for a stream.
   * @param {string} streamId - The stream ID
   * @param {boolean} enabled - Whether YOLO mode is enabled
   */
  setApprovalBypass(streamId, enabled) {
    const targetStream = this._resolveStreamId(streamId);
    if (!targetStream) return;

    if (enabled) {
      this.approvalBypassByStream.set(targetStream, true);
    } else {
      this.approvalBypassByStream.delete(targetStream);
    }
  }

  /**
   * Get YOLO mode (approval bypass) for a stream.
   * @param {string} streamId - The stream ID
   * @returns {boolean}
   */
  getApprovalBypass(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (!targetStream) return false;
    return this.approvalBypassByStream.get(targetStream) ?? false;
  }

  /**
   * Clear YOLO mode (approval bypass) for a specific stream.
   * @param {string} streamId - The stream ID
   */
  clearApprovalBypass(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream) {
      this.approvalBypassByStream.delete(targetStream);
    }
  }

  /**
   * Clear all YOLO mode states across all streams.
   */
  clearAllApprovalBypass() {
    this.approvalBypassByStream.clear();
  }
}

export const progressViewState = new ProgressViewState();
