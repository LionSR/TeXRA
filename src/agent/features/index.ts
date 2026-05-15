import { registerMemoryFeature } from './registerMemory';
import { registerOdysseyFeature } from './registerOdyssey';

// Must be called after initPlatform(): predicates read host services
// (platform().config, getGlobalState).
export function registerAgentFeatures(): void {
  registerMemoryFeature();
  registerOdysseyFeature();
}

export { registerMemoryFeature, registerOdysseyFeature };
