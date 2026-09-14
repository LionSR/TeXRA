/**
 * Goal tools — the shared goal-lifecycle surface for agent, controller, and
 * host code.
 *
 * Consumers import `@tools/goal` instead of reaching into the feature flag,
 * row, or approval modules individually. Those modules are implementation
 * details of one goal subsystem; tests use the same door as production so a
 * future internal split does not create a second public surface accidentally.
 * One exception: `@agent/runtime/toolInjection` imports `./goalFeatureFlag`
 * directly, because this barrel's `goalRows` would pull the session graph
 * into a module that tool resolution loads.
 */
export { isGoalEnabled } from './goalFeatureFlag';
export {
  clearGoal,
  goalList,
  goalOf,
  goalStateChanges,
  pauseGoal,
  retargetGoal,
  startGoal,
  type GoalStateChange,
  type GoalReader,
} from './goalRows';
export {
  setGoalSessionAutoApproval,
  type GoalAutoApprovalScope,
} from './goalAutoApproval';
