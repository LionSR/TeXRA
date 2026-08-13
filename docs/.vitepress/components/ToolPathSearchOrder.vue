<script setup>
// Frameless cross-platform "where TeXRA looks for tools, in order" map for the
// troubleshooting page's "Check PATH environment" fix. When VS Code is launched
// from Finder / the Start menu it inherits a minimal PATH, so TeXRA probes a
// ranked list of well-known install dirs per OS to find latexmk / perl / gm /
// gs. The source prose nests three numbered lists (macOS / Windows / Linux),
// each 8-9 deep — exactly the scan-not-read shape a reader debugging "tool not
// found" hits. Rendering one mono column per OS with numbered, ordered rows lets
// them jump to their platform and read the probe order at a glance; a callout
// carries the kpsewhich / texmf-dist fallback. The prose list below stays as the
// exhaustive reference.
//
// Card shell + inline mono header come by COMPOSITION from <MockCard>, so the
// shared --mk-* colour + dimensional tokens resolve and the figure flips cleanly
// between the docs light / dark themes.
import MockCard from './MockCard.vue';

const platforms = [
  {
    title: 'macOS',
    paths: [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Library/TeX/texbin',
      '/usr/texbin',
      'MiKTeX Console.app/…/bin',
      '~/bin',
      '/usr/local/texlive/2024/…',
      '~/texlive/* · ~/TinyTeX/bin',
    ],
  },
  {
    title: 'Windows',
    paths: [
      'Program Files\\MiKTeX\\…\\x64',
      'Program Files\\MiKTeX\\…\\bin',
      'Program Files (x86)\\MiKTeX',
      '%LOCALAPPDATA%\\…\\MiKTeX\\x64',
      '%LOCALAPPDATA%\\…\\MiKTeX',
      'MiKTeX 2.9\\…\\x64 (legacy)',
      '%LOCALAPPDATA%\\MiKTeX\\…\\x64',
      'C:\\texlive\\2024\\bin\\windows',
    ],
  },
  {
    title: 'Linux',
    paths: [
      '/usr/local/bin',
      '/usr/bin',
      '/opt/miktex/bin',
      '/snap/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      '~/bin',
      'texlive/<year>/bin/*',
      '~/texlive/* · ~/TinyTeX',
    ],
  },
];
</script>

<template>
  <div class="mockup tps-wrap" role="group" aria-label="Tool PATH search order">
    <div class="tps-grid">
      <MockCard
        v-for="(p, i) in platforms"
        :key="i"
        class="tps-col"
        icon="terminal"
        :title="p.title"
      >
        <ol class="tps-list">
          <li v-for="(path, j) in p.paths" :key="j" class="tps-row">
            <span class="tps-rank">{{ j + 1 }}</span>
            <code class="tps-path">{{ path }}</code>
          </li>
        </ol>
      </MockCard>
    </div>

    <div class="tps-fallback">
      <wa-icon class="tps-fb-ic" library="texra" name="search"></wa-icon>
      <span class="tps-fb-tx">
        Not found in standard paths? TeXRA scans
        <code>texmf-dist/scripts</code> and uses <code>kpsewhich</code> to
        locate Perl helpers like <code>latexdiff.pl</code>.
      </span>
    </div>
  </div>
</template>

<style scoped>
.tps-wrap {
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}

.tps-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--mk-space-12);
}
@media (max-width: 720px) {
  .tps-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.tps-col {
  min-width: 0;
}

.tps-list {
  list-style: none;
  margin: var(--mk-space-4) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-3);
}
.tps-row {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  min-width: 0;
}
.tps-rank {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-size-21);
  height: var(--mk-size-21);
  border-radius: var(--mk-radius-pill);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
  color: var(--mk-accent);
  font-size: var(--mk-fs-66);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tps-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  color: var(--mk-text);
  background: none;
  padding: 0;
}

.tps-fallback {
  display: flex;
  align-items: flex-start;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-12);
  padding: var(--mk-space-9) var(--mk-space-11);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-md);
  background: color-mix(in srgb, var(--mk-accent) 6%, transparent);
}
.tps-fb-ic {
  flex: none;
  margin-top: 1px;
  color: var(--mk-accent);
  font-size: var(--mk-fs-78);
}
.tps-fb-tx {
  font-size: var(--mk-fs-77);
  line-height: 1.55;
  color: var(--mk-text);
}
.tps-fb-tx code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  background: none;
  padding: 0;
  color: var(--mk-syn-fn);
}
</style>
