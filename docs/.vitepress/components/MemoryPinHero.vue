<script setup>
// Frameless pinned-vs-unpinned slice: two note cards side by side so the
// difference reads at a glance. The pinned card has the blue left border +
// a `Pinned` badge and loads at every session start; the unpinned card is
// plain searchable context, read on demand. Standalone (no MockupFrame /
// dash-nav) — reuses the visual vocabulary of MemoryHero's `.mem-item`
// cards, but self-contained so it can sit inline in guide/memory.md.
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional
// tokens resolve here and the cards flip cleanly in light / dark.
</script>

<template>
  <div
    class="mockup mem-pins"
    role="group"
    aria-label="pinned vs unpinned note"
  >
    <!-- Pinned -->
    <figure class="pin-col">
      <div class="mem-item pinned">
        <div class="mem-head">
          <div class="mem-path">/memories/project-conventions.md</div>
          <button
            type="button"
            class="m-act m-act-on"
            title="Unpin this memory"
          >
            <wa-icon library="texra" name="thumbtack-slash"></wa-icon>
          </button>
        </div>
        <div class="mem-meta">
          <span class="pin-badge">Pinned</span>
          <span class="meta-dot">·</span>
          <span>1.2 KB</span>
          <span class="meta-dot">·</span>
          <span>34 lines</span>
          <span class="meta-dot">·</span>
          <span>by research</span>
        </div>
      </div>
      <figcaption class="pin-cap">
        Loaded at the start of every session — up to 10 notes.
      </figcaption>
    </figure>

    <!-- Unpinned -->
    <figure class="pin-col">
      <div class="mem-item">
        <div class="mem-head">
          <div class="mem-path">/memories/figures.md</div>
          <button
            type="button"
            class="m-act"
            title="Pin as core long-term memory"
          >
            <wa-icon library="texra" name="thumbtack"></wa-icon>
          </button>
        </div>
        <div class="mem-meta">
          <span>312 B</span>
          <span class="meta-dot">·</span>
          <span>9 lines</span>
          <span class="meta-dot">·</span>
          <span>by chat</span>
        </div>
      </div>
      <figcaption class="pin-cap">
        Searchable context — read on demand, not in every prompt.
      </figcaption>
    </figure>
  </div>
</template>

<style scoped>
/* Standalone two-up. Tokens come from `.mockup` (theme/mockup.css). The card
   markup mirrors MemoryHero's `.mem-item` so the pinned cue (blue left border
   + `Pinned` badge) reads identically, but the styles are self-contained. */
.mem-pins {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--mk-space-12);
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
}

.pin-col {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
  min-width: 0;
}

.mem-item {
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-10) var(--mk-space-12);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
}
.mem-item.pinned {
  border-left: 2px solid var(--color-text-link);
  padding-left: calc(var(--mk-space-12) - 1px);
}

.mem-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.mem-path {
  flex: 1;
  min-width: 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  font-weight: 500;
  color: var(--color-text-link);
  word-break: break-all;
}
.m-act {
  background: transparent;
  border: none;
  width: var(--mk-space-22);
  height: var(--mk-space-22);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--mk-radius-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
  flex-shrink: 0;
}
.m-act wa-icon {
  font-size: var(--mk-space-12);
}
.m-act:hover {
  background: rgba(127, 127, 127, 0.12);
  color: var(--wa-color-text-normal);
}
.m-act-on {
  color: var(--color-text-link);
}

.mem-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-70);
  color: var(--color-text-secondary);
}
.meta-dot {
  color: var(--color-text-tertiary);
}
.pin-badge {
  color: var(--color-text-link);
  font-weight: 600;
}

.pin-cap {
  margin: 0;
  font-size: var(--mk-fs-72);
  line-height: 1.45;
  color: var(--mk-text-faint);
}

@media (max-width: 560px) {
  .mem-pins {
    grid-template-columns: 1fr;
  }
}
</style>
