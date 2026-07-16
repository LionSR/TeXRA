import { describe, expect, it } from 'vitest';

import { isNewerSemverVersion } from '@utils/system/semverUpdateCheck';

describe('isNewerSemverVersion', () => {
  it('compares numerically across all components', () => {
    expect(isNewerSemverVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerSemverVersion('0.39.0', '0.38.2')).toBe(true);
    expect(isNewerSemverVersion('0.38.3', '0.38.2')).toBe(true);
    expect(isNewerSemverVersion('0.38.2', '0.38.2')).toBe(false);
    expect(isNewerSemverVersion('0.38.1', '0.38.2')).toBe(false);
  });

  it('ranks a release above its prerelease but not vice versa', () => {
    expect(isNewerSemverVersion('1.2.0', '1.2.0-rc.1')).toBe(true);
    expect(isNewerSemverVersion('1.2.0-rc.1', '1.2.0')).toBe(false);
    expect(isNewerSemverVersion('1.2.0-rc.2', '1.2.0-rc.1')).toBe(true);
  });

  it('returns false when either version is unparseable', () => {
    expect(isNewerSemverVersion('1.0.0', 'unknown')).toBe(false);
    expect(isNewerSemverVersion('latest', '1.0.0')).toBe(false);
    expect(isNewerSemverVersion('not-a-version', '0.39.3')).toBe(false);
    expect(isNewerSemverVersion('0.40.0', 'not-a-version')).toBe(false);
  });
});
