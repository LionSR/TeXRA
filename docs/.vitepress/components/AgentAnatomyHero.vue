<script setup>
import MockCard from './MockCard.vue';

// Frameless "agent anatomy" map for guide/custom-agents.md, Step 3. The starter
// template a custom-agent author edits is a ~60-line YAML block; this figure
// lifts its part-whole structure out of the comments into three labelled bands —
// inherits / settings / prompts — and draws the one relationship the prose
// spends a Reflection Tips callout explaining: the `userRequest` array maps
// position-by-position onto rounds (item [0] = Round 0, item [1] = reflection).
//
// Standalone (no MockupFrame). The root carries `.mockup` so the shared `--mk-*`
// colour + dimensional tokens (theme/mockup.css) resolve here and the card flips
// cleanly between the docs light / dark themes. Keys mirror the YAML on the page
// verbatim (inherits: polish, agentCategory: workflow, rounds: 2,
// systemPrompt / userPrefix / userRequest).

// The three top-level YAML sections, each captioned by its role.
const bands = [
  {
    key: 'inherits: polish',
    role: 'starts from a built-in parent',
  },
  {
    key: 'settings:',
    role: 'how it behaves',
    fields: ['agentCategory: workflow', 'rounds: 2'],
  },
  {
    key: 'prompts:',
    role: 'what it says',
    fields: ['systemPrompt:', 'userPrefix:', 'userRequest:'],
    // userRequest is the band that wires into the round map on the right.
    mapsToRounds: true,
  },
];

// The userRequest array → rounds mapping the figure makes explicit.
const rounds = [
  { idx: '[0]', title: 'Round 0', sub: 'initial draft' },
  { idx: '[1]', title: 'Round 1', sub: 'reflection' },
];
</script>

<template>
  <MockCard
    class="anat"
    icon="edit"
    title="custom_agent.yaml"
    sub="three sections, one mapping"
  >
    <div class="anat-grid">
      <ul class="anat-bands">
        <li v-for="(b, i) in bands" :key="i" class="anat-band">
          <div class="anat-band-head">
            <code class="anat-key">{{ b.key }}</code>
            <span class="anat-role">{{ b.role }}</span>
          </div>
          <ul v-if="b.fields" class="anat-fields">
            <li
              v-for="(f, j) in b.fields"
              :key="j"
              class="anat-field"
              :class="{ 'anat-field--map': b.mapsToRounds && j === 2 }"
            >
              <code>{{ f }}</code>
              <span v-if="b.mapsToRounds && j === 2" class="anat-field-note"
                >array → rounds</span
              >
            </li>
          </ul>
        </li>
      </ul>

      <aside class="anat-rounds" aria-label="userRequest array maps to rounds">
        <ul class="anat-round-list">
          <li v-for="(r, i) in rounds" :key="i" class="anat-round">
            <code class="anat-round-idx">userRequest{{ r.idx }}</code>
            <div class="anat-round-body">
              <span class="anat-round-title">{{ r.title }}</span>
              <span class="anat-round-sub">{{ r.sub }}</span>
            </div>
          </li>
        </ul>
        <p class="anat-rounds-cap">Extra entries add more reflection rounds.</p>
      </aside>
    </div>
  </MockCard>
</template>

<style scoped>
/* Card shell + inline mono header come from <MockCard> (.mk-card* family in
   theme/mockup.css). Only the body — the bands grid below — is scoped here. */
.anat {
  margin: var(--mk-space-16) 0;
}

.anat-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  gap: var(--mk-space-14);
  align-items: start;
}

.anat-bands {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  min-width: 0;
}
.anat-band {
  border: 1px solid var(--mk-border-soft);
  border-left: 2px solid var(--mk-accent);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-7) var(--mk-space-10);
  /* Accent tint derived from the (theme-flipping) accent so the band tints
     correctly in light mode too — a fixed dark-accent rgba reads as the wrong
     hue on the light surface. */
  background: color-mix(in srgb, var(--mk-accent) 6%, transparent);
}
.anat-band-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}
.anat-key {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-syn-keyword);
  flex-shrink: 0;
}
.anat-role {
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
  min-width: 0;
}

.anat-fields {
  list-style: none;
  margin: var(--mk-space-6) 0 0;
  padding: 0 0 0 var(--mk-space-10);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-3);
  border-left: 1px solid var(--mk-border-soft);
}
.anat-field {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-6);
}
.anat-field code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  color: var(--mk-text);
}
.anat-field--map code {
  color: var(--mk-accent);
  font-weight: 600;
}
.anat-field-note {
  font-size: var(--mk-fs-66);
  color: var(--mk-accent);
  font-style: italic;
}

/* Right column: the userRequest array → rounds map. */
.anat-rounds {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-7);
  min-width: 0;
}
.anat-round-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
}
.anat-round {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  padding: var(--mk-space-7) var(--mk-space-9);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  background: var(--mk-bg-soft);
  position: relative;
}
/* A subtle leader from the userRequest band into each round tile. */
.anat-round::before {
  content: '←';
  position: absolute;
  left: calc(-1 * var(--mk-space-12));
  color: var(--mk-accent);
  font-size: var(--mk-fs-78);
}
.anat-round-idx {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-66);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 1px var(--mk-space-5);
  flex-shrink: 0;
}
.anat-round-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.anat-round-title {
  font-size: var(--mk-fs-78);
  font-weight: 700;
  color: var(--mk-text);
}
.anat-round-sub {
  font-size: var(--mk-fs-70);
  color: var(--color-text-secondary);
}
.anat-rounds-cap {
  margin: 0;
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
  line-height: 1.4;
}

/* Stack the round map under the bands on narrow screens; drop the ← leaders. */
@media (max-width: 620px) {
  .anat-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .anat-round::before {
    content: none;
  }
}
</style>
