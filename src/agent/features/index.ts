import { registerMemoryFeature } from './registerMemory';
import { registerOdysseyFeature } from './registerOdyssey';

/**
 * Bootstrap all agent-side feature integrations: idle-continuation providers
 * and conditional tool injections. Hosts must call this exactly once, AFTER
 * `initPlatform()` (predicates read host services), at composition root.
 */
export function registerAgentFeatures(): void {
  registerMemoryFeature();
  registerOdysseyFeature();
}

export { registerMemoryFeature, registerOdysseyFeature };
