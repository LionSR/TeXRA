/**
 * Goal tools — the shared goal-lifecycle surface for agent, controller, and
 * host code.
 *
 * Consumers import `@tools/goal` instead of reaching into the feature flag,
 * store, or approval modules individually. Those modules are implementation
 * details of one goal subsystem; tests use the same door as production so a
 * future internal split does not create a second public surface accidentally.
 * One exception: `@agent/runtime/toolInjection` imports `./goalFeatureFlag`
 * directly, because this barrel's `goalStore` would pull the session graph
 * into a module that tool resolution loads.
 */
export { isGoalEnabled } from './goalFeatureFlag';
export { GoalStore, goalStateChanges, type GoalStateChange } from './goalStore';
export {
  setGoalSessionAutoApproval,
  type GoalAutoApprovalScope,
} from './goalAutoApproval';
