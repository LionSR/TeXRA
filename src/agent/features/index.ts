import { registerMemoryFeature } from './registerMemory';
import { registerGoalFeature } from './registerGoal';

// Must be called after initPlatform(): predicates read host services
// (platform().config, platform().globalState).
export function registerAgentFeatures(): void {
  registerMemoryFeature();
  registerGoalFeature();
}
