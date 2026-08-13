<script setup>
import MockCard from './MockCard.vue';

// Frameless "output mapping" figure for guide/custom-agents.md, Example:
// Multiple Output Agent + Strict XML Extraction. The crux of multi-file agents
// is a contract that the prose + templated YAML only describes: the model emits
// one `<document name="...">` block per declared output filename, and TeXRA
// saves each block to the file whose name matches. This figure renders that
// mapping directly — XML blocks on the left, saved files on the right, matched
// by name — and shows the failure mode the page warns about: a `name` that is
// not in the list is skipped, nothing saved.
//
// Standalone (no MockupFrame). The root carries `.mockup` so the shared `--mk-*`
// tokens (theme/mockup.css) resolve here and the card flips with the docs theme.
// Filenames mirror the example on the page (introduction.tex, conclusion.tex).

// Left → right rows. `match: true` = name in the declared list → saved;
// `match: false` = mismatched name → skipped (the Strict XML failure mode).
const rows = [
  { name: 'introduction.tex', match: true },
  { name: 'conclusion.tex', match: true },
  { name: 'summary.tex', match: false },
];
</script>

<template>
  <MockCard
    class="omap"
    icon="files"
    title="Multiple output"
    sub="<document name> → saved file"
  >
    <div class="omap-grid">
      <!-- LEFT: the XML the model emits -->
      <div class="omap-col">
        <header class="omap-col-head">Model output</header>
        <ul class="omap-blocks">
          <li
            v-for="(r, i) in rows"
            :key="i"
            class="omap-block"
            :class="{ 'omap-block--skip': !r.match }"
          >
            <code class="omap-xml">
              <span class="omap-tag">&lt;document</span>
              <span class="omap-attr">
                name=<span class="omap-val">"{{ r.name }}"</span></span
              ><span class="omap-tag">&gt;</span>
            </code>
            <code class="omap-xml omap-xml--body">… content …</code>
            <code class="omap-xml omap-tag">&lt;/document&gt;</code>
          </li>
        </ul>
      </div>

      <!-- MIDDLE: name-matched connectors -->
      <ul class="omap-links" aria-hidden="true">
        <li
          v-for="(r, i) in rows"
          :key="i"
          class="omap-link"
          :class="{ 'omap-link--skip': !r.match }"
        >
          {{ r.match ? '→' : '⤫' }}
        </li>
      </ul>

      <!-- RIGHT: the files TeXRA saves -->
      <div class="omap-col">
        <header class="omap-col-head">TeXRA saves</header>
        <ul class="omap-files">
          <li
            v-for="(r, i) in rows"
            :key="i"
            class="omap-file"
            :class="{ 'omap-file--skip': !r.match }"
          >
            <wa-icon
              class="omap-fi-ic"
              library="texra"
              :name="r.match ? 'file-code' : 'circle-slash'"
            ></wa-icon>
            <span class="omap-fi-name">{{ r.name }}</span>
            <span
              class="omap-fi-badge"
              :class="r.match ? 'omap-fi-badge--ok' : 'omap-fi-badge--skip'"
              >{{ r.match ? 'saved' : 'name not in list → skipped' }}</span
            >
          </li>
        </ul>
      </div>
    </div>
  </MockCard>
</template>

<style scoped>
/* Card shell + inline mono header come from <MockCard> (.mk-card* family in
   theme/mockup.css). Only the body — the two columns + connectors — is scoped. */
.omap {
  margin: var(--mk-space-16) 0;
}

.omap-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) auto minmax(0, 1fr);
  gap: var(--mk-space-8);
  align-items: start;
}

.omap-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-7);
}
.omap-col-head {
  font-size: var(--mk-fs-68);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}

/* LEFT: XML blocks */
.omap-blocks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
}
.omap-block {
  display: flex;
  flex-direction: column;
  padding: var(--mk-space-6) var(--mk-space-8);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  background: var(--mk-bg-soft);
}
.omap-block--skip {
  opacity: 0.62;
  border-style: dashed;
}
.omap-xml {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  line-height: 1.55;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.omap-xml--body {
  color: var(--mk-text-faint);
  padding-left: var(--mk-space-10);
}
.omap-tag {
  color: var(--mk-syn-keyword);
}
.omap-attr {
  color: var(--mk-syn-fn);
}
.omap-val {
  color: var(--mk-ins-text);
  font-weight: 600;
}

/* MIDDLE: connectors, one per row */
.omap-links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  /* Push the arrows down past each column head to align with the rows. */
  padding-top: calc(var(--mk-fs-68) + var(--mk-space-7));
}
.omap-link {
  /* Match a block's rough height so each arrow tracks its row. */
  min-height: calc(var(--mk-fs-72) * 1.55 * 2 + var(--mk-space-6) * 2 + 2px);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--mk-fs-90);
  color: var(--mk-accent);
}
.omap-link--skip {
  color: var(--mk-del-text);
}

/* RIGHT: saved files */
.omap-files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
}
.omap-file {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-6);
  /* Match the left block height so rows line up across the connectors. */
  min-height: calc(var(--mk-fs-72) * 1.55 * 2 + var(--mk-space-6) * 2 + 2px);
  padding: var(--mk-space-6) var(--mk-space-8);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
}
.omap-file--skip {
  opacity: 0.62;
  border-style: dashed;
}
.omap-fi-ic {
  font-size: var(--mk-fs-90);
  color: var(--color-text-link);
  flex-shrink: 0;
}
.omap-file--skip .omap-fi-ic {
  color: var(--mk-del-text);
}
.omap-fi-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  color: var(--mk-text);
  min-width: 0;
}
.omap-fi-badge {
  flex-basis: 100%;
  font-size: var(--mk-fs-64);
  font-weight: 600;
  line-height: 1.4;
}
.omap-fi-badge--ok {
  color: var(--mk-ins-text);
}
.omap-fi-badge--skip {
  color: var(--mk-del-text);
}

/* On narrow screens, drop the connector column and stack name→file pairs. */
@media (max-width: 620px) {
  .omap-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .omap-links {
    display: none;
  }
  .omap-link {
    min-height: 0;
  }
}
</style>
