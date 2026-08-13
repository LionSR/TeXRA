import { readFileSync } from 'node:fs';

import { getIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { TEXRA_ICON_CANONICAL_NAMES } from '@shared/wa/iconNames';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

import { desktopSourcePath } from './desktopTestPaths.ts';
import { loadSourceModule } from './loadSourceModule.ts';

type IconResolver = NonNullable<ReturnType<typeof getIconLibrary>>['resolver'];

let texraResolver: IconResolver;
let defaultResolver: IconResolver;

beforeAll(async () => {
  await loadSourceModule('@desktop/renderer/desktopIconLibrary');
  const texraLibrary = getIconLibrary(TEXRA_ICON_LIBRARY);
  const defaultLibrary = getIconLibrary('default');
  if (!texraLibrary || !defaultLibrary) {
    throw new Error('Desktop icon libraries were not registered.');
  }
  texraResolver = texraLibrary.resolver;
  defaultResolver = defaultLibrary.resolver;
});

async function resolve(resolver: IconResolver, name: string): Promise<string> {
  return resolver(name, 'classic', 'solid', false);
}

function decodeSvg(uri: string): string {
  expect(uri).toMatch(/^data:image\/svg\+xml,/);
  return decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
}

/**
 * The TeXRA names that carry an explicit Lucide rename, read from the source
 * table. Read rather than exported: the table is module-private data with one
 * consumer (its own resolver), and exporting it only for a test would make a
 * contract out of an implementation detail.
 */
function readRenamedIconNames(): readonly string[] {
  const source = readFileSync(
    desktopSourcePath('renderer', 'desktopIconLibrary.ts'),
    'utf8',
  );
  const table = source.slice(
    source.indexOf('const LUCIDE_NAME_BY_TEXRA_NAME'),
    source.indexOf('const LUCIDE_ICON_NODES'),
  );
  return [...table.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'[a-z0-9-]+',/gm)].map(
    (match) => match[1]!,
  );
}

describe('desktop icon library', () => {
  it('renders mapped icons with the Lucide stroke treatment', async () => {
    const svg = decodeSvg(await resolve(texraResolver, 'file-lines'));

    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).toContain('fill="none"');
  });

  it('maps former icon-family gaps to Lucide glyphs', async () => {
    const svg = decodeSvg(await resolve(texraResolver, 'thumbtack-slash'));

    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).not.toContain('<path fill="currentColor"');
  });

  it('keeps canonical and unknown runtime names visible in both libraries', async () => {
    const canonicalSvg = decodeSvg(await resolve(texraResolver, 'paper-plane'));
    const unknownSvg = decodeSvg(
      await resolve(defaultResolver, 'unexpected-runtime-icon'),
    );

    expect(canonicalSvg).toContain('stroke-width="1.75"');
    expect(canonicalSvg).not.toContain('<path fill="currentColor"');
    expect(unknownSvg).toContain('stroke-width="1.75"');
  });

  it.each([
    {
      // A mapping whose target Lucide dropped or renamed would silently become
      // the unknown-icon marker. Walking the map catches that drift.
      table: 'renamed icon',
      readNames: readRenamedIconNames,
      unmapped: 'circle-question',
      // Guards the parse itself: an empty list would make the walk vacuous.
      minimumSize: 50,
    },
    {
      table: 'canonical TeXRA name',
      readNames: () => TEXRA_ICON_CANONICAL_NAMES,
      unmapped: 'circle-question',
      minimumSize: 100,
    },
  ])(
    'resolves every $table to a pinned Lucide glyph',
    async ({ readNames, unmapped, minimumSize }) => {
      const names = readNames();
      const unresolved: string[] = [];
      const missingSvg = decodeSvg(
        await resolve(texraResolver, 'unexpected-runtime-icon'),
      );

      for (const name of names) {
        const svg = decodeSvg(await resolve(texraResolver, name));
        if (svg === missingSvg && name !== unmapped) unresolved.push(name);
      }

      expect(unresolved).toEqual([]);
      expect(names.length).toBeGreaterThan(minimumSize);
    },
  );
});
