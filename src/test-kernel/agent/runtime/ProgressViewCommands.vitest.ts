import { afterEach, describe, expect, it } from 'vitest';

import {
  isRuntimeProgressViewVisible,
  registerRuntimeProgressViewVisibilityProvider,
  type RuntimeProgressViewVisibilityRegistration,
} from '@agent/runtime/progressViewCommands';

describe('runtime progress-view commands', () => {
  const registrations: RuntimeProgressViewVisibilityRegistration[] = [];

  afterEach(() => {
    for (const registration of registrations.toReversed()) {
      registration.dispose();
    }
    registrations.length = 0;
  });

  function registerVisible(
    visible: boolean,
  ): RuntimeProgressViewVisibilityRegistration {
    const registration = registerRuntimeProgressViewVisibilityProvider({
      isViewVisible: () => visible,
    });
    registrations.push(registration);
    return registration;
  }

  it('defaults to hidden until a host registers a visibility provider', () => {
    registerVisible(false);

    expect(isRuntimeProgressViewVisible()).toBe(false);

    registerVisible(true);

    expect(isRuntimeProgressViewVisible()).toBe(true);
  });

  it('reports visible when any registered host progress surface is visible', () => {
    const first = registerRuntimeProgressViewVisibilityProvider({
      isViewVisible: () => true,
    });
    registrations.push(first);

    const second = registerRuntimeProgressViewVisibilityProvider({
      isViewVisible: () => false,
    });
    registrations.push(second);

    expect(isRuntimeProgressViewVisible()).toBe(true);

    first.dispose();
    expect(isRuntimeProgressViewVisible()).toBe(false);
  });

  it('disposes only the matching visibility provider registration', () => {
    const first = registerRuntimeProgressViewVisibilityProvider({
      isViewVisible: () => false,
    });
    registrations.push(first);

    expect(isRuntimeProgressViewVisible()).toBe(false);

    const second = registerRuntimeProgressViewVisibilityProvider({
      isViewVisible: () => true,
    });
    registrations.push(second);

    expect(isRuntimeProgressViewVisible()).toBe(true);

    first.dispose();
    expect(isRuntimeProgressViewVisible()).toBe(true);

    second.dispose();
    expect(isRuntimeProgressViewVisible()).toBe(false);
  });
});
