import { getIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  registerTeXRAWebAwesomeIcons,
  TEXRA_ICON_LIBRARY,
} from '@shared/wa/webAwesomeIcons';

type IconResolver = NonNullable<ReturnType<typeof getIconLibrary>>['resolver'];

let texraResolver: IconResolver;

beforeAll(() => {
  registerTeXRAWebAwesomeIcons();
  const texraLibrary = getIconLibrary(TEXRA_ICON_LIBRARY);
  if (!texraLibrary) throw new Error('TeXRA icon library was not registered.');
  texraResolver = texraLibrary.resolver;
});

describe('extension Web Awesome icon registration', () => {
  // #6981: retire this compatibility regression with the private alias table
  // after 2026-10-29, once supported extension data cannot contain old names.
  it('resolves retained legacy aliases through the public registration surface', async () => {
    const legacyIcon = await texraResolver('tools', 'classic', 'solid', false);
    const canonicalIcon = await texraResolver(
      'screwdriver-wrench',
      'classic',
      'solid',
      false,
    );

    expect(legacyIcon).toBe(canonicalIcon);
    expect(legacyIcon).toMatch(/^data:image\/svg\+xml,/);
  });
});
