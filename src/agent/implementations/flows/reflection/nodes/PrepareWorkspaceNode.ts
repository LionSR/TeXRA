/**
 * PrepareWorkspaceNode - Initializes workspace state for a round.
 *
 * Minimal node that creates a fresh AgentWorkspaceState.
 * TeXCount and media extraction are handled by separate nodes.
 *
 * PocketFlow pattern:
 * - prep(): Extract round info
 * - exec(): Create fresh workspace state
 * - post(): Store in shared
 *
 * This node is always successful - it just creates empty state.
 */

import { Node } from '@agent/node';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type { ReflectionFlowParams } from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

interface WorkspacePrepInput {
  currentRound: number;
}

interface WorkspaceExecResult {
  workspaceState: AgentWorkspaceState;
}

// ============================================================================
// Node Implementation
// ============================================================================

export class PrepareWorkspaceNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams<C>
> {
  constructor() {
    super(1, 0); // maxRetries=1, wait=0
  }

  /**
   * Extract round info.
   */
  async prep(shared: ReflectionFlowShared): Promise<WorkspacePrepInput> {
    return {
      currentRound: shared.state.currentRound,
    };
  }

  /**
   * Create fresh workspace state.
   */
  async exec(_prepRes: WorkspacePrepInput): Promise<WorkspaceExecResult> {
    return {
      workspaceState: AgentWorkspaceState.create(),
    };
  }

  /**
   * Store workspace state in shared.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: WorkspacePrepInput,
    execRes: WorkspaceExecResult,
  ): Promise<string | undefined> {
    const { logger } = this._params.services;

    // Store in shared state
    shared.state.workspaceState = execRes.workspaceState;

    logger.debug(`Workspace state initialized for round ${shared.state.currentRound}`);

    // Continue to TeXCountNode
    return undefined;
  }
}
