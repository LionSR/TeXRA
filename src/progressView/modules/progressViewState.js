// Third-party imports
import { z } from 'zod';

// Local imports - progress view
// Local imports - state management helper
import { WebviewStateManager } from '@common/webviewState.js';

// Zod schema for toggle state entries
const ToggleStateEntrySchema = z.tuple([z.string(), z.boolean()]);
const ToggleStatesSchema = z.array(ToggleStateEntrySchema);

// Zod schema for task group updates
const TaskGroupUpdateSchema = z.object({
  status: z.string().optional(),
  endTime: z.number().nullable().optional(),
  usage: z.any().optional(),
});

/**
 * Manages task groups in the progress view.
 */
class TaskGroups {
  constructor() {
    this.groups = new Map();
    this._cachedTotals = null;
  }

  get(id) {
    return this.groups.get(id) ?? null;
  }

  set(id, group) {
    if (!id || !group) return;
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
    const { groupId, updates = {} } = payload ?? {};
    const group = this.groups.get(groupId);
    if (!group) return;

    try {
      const validated = TaskGroupUpdateSchema.parse(updates);
      
      if (validated.status) {
        group.status = validated.status;
      }
      if (validated.endTime !== undefined && validated.endTime !== null) {
        group.endTime = validated.endTime;
      }
      if (validated.usage !== undefined) {
        group.usage = validated.usage;
      }

      this.groups.set(groupId, group);
      this._cachedTotals = null;
    } catch (error) {
      console.error('Invalid task group update:', error);
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
    if (!id || typeof collapsed !== 'boolean') return;
    this.states.set(id, collapsed);
    this.saveCallback?.();
  }

  get(id) {
    return this.states.get(id);
  }

  clearSelection(ids) {
    [ids].flat().filter(Boolean).forEach((id) => this.states.delete(id));
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
    if (stream && status && typeof status === 'string' && status !== 'ready') {
      this.statuses.set(stream, status);
    }
  }

  delete(stream) {
    if (stream) this.statuses.delete(stream);
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
    if (stream) this.availability.set(stream, Boolean(hasExecutionId));
  }

  hasExecutionId(stream) {
    return this.availability.get(stream) ?? false;
  }

  delete(stream) {
    if (stream) this.availability.delete(stream);
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
    if (!previous.groupToggleStates) return;

    try {
      // Handle legacy string format
      let data = previous.groupToggleStates;
      if (typeof data === 'string') {
        data = JSON.parse(data);
      }

      // Validate with Zod
      const validated = ToggleStatesSchema.parse(data);
      this.toggleStates.load(validated);
    } catch (error) {
      console.error(
        'Failed to restore group toggle states:',
        error instanceof Error ? error.message : String(error),
      );
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
}

export const progressViewState = new ProgressViewState();
