<script setup>
// Focused diagnostic figure for the "When something looks wrong" section of the
// agent-yaml-migration guide. The prose version was four multi-line bullets that
// a reader scans for the SYMPTOM that matches their broken custom YAML, then
// reads the cause + fix. A flat bullet list buries that symptom→cause→fix shape;
// these cards surface it. Each card: a symptom title, the underlying cause, and
// the concrete fix (with the canonical {{ ... }} replacement called out).
//
// Reuses the shared .mk-card / .mk-card-head shells via MockCard (frameless,
// theme-adaptive). The literal {{ TEMPLATE_VARS }} are emitted as HTML entities
// so Vue never interpolates them.
import MockCard from './MockCard.vue';

const cases = [
  {
    icon: 'warning',
    symptom: 'Empty context section in prompt',
    cause:
      'Your YAML still uses an old alias like {{ ALL_AUXILIARYS }}. No UI exposes an "auxiliary" picker any more, so users have nothing to attach.',
    fixLabel: 'Switch to',
    fixVar: 'ALL_CONTEXTS',
    fixNote: 'users then see the unified Context picker.',
  },
  {
    icon: 'file',
    symptom: 'Output named output.tex, not the input filename',
    cause: 'Your YAML hard-codes <document name="output.tex">.',
    fixLabel: 'Use',
    fixVar: 'INPUT_FILE',
    fixNote:
      'resolves to inputFiles[0], or let the agent name files from ALL_INPUTS.',
  },
  {
    icon: 'copy',
    symptom: 'Two agents write the same file',
    cause:
      'Pre-W4 you had distinct inputFile and inputFiles[0] semantics; now they are one slot.',
    fixLabel: 'Adjust',
    fixVar: null,
    fixNote: 'the prompt to handle a single input list.',
  },
  {
    icon: 'settings',
    symptom: 'Custom keyword filter no longer matches',
    cause:
      'A customized auxiliaryKeywords filter is now folded into the Context category’s ignoredKeywords back-compat shim.',
    fixLabel: 'Migrate to',
    fixVar: null,
    fixNote: 'texra.files.ignored.keywords to filter across all categories.',
  },
];
</script>

<template>
  <div class="mockup mtr">
    <div class="mtr-grid">
      <MockCard
        v-for="c in cases"
        :key="c.symptom"
        class="mtr-card"
        :icon="c.icon"
        :title="c.symptom"
        sub="symptom"
      >
        <div class="mtr-body">
          <p class="mtr-cause">{{ c.cause }}</p>
          <p class="mtr-fix">
            <span class="mtr-fix-tag">fix</span>
            <span class="mtr-fix-text">
              {{ c.fixLabel }}
              <code v-if="c.fixVar" class="mtr-var"
                >&#123;&#123; {{ c.fixVar }} &#125;&#125;</code
              >
              {{ c.fixNote }}
            </span>
          </p>
        </div>
      </MockCard>
    </div>
  </div>
</template>

<style scoped>
.mtr-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mk-space-10);
}
.mtr-card {
  min-width: 0;
}
.mtr-body {
  padding: var(--mk-space-10);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  font-family: var(--vp-font-family-base);
}
.mtr-cause {
  margin: 0;
  font-size: var(--mk-fs-74);
  line-height: 1.45;
  color: var(--mk-text-dim);
}
.mtr-fix {
  margin: 0;
  display: flex;
  gap: var(--mk-space-7);
  align-items: baseline;
  font-size: var(--mk-fs-74);
  line-height: 1.45;
  color: var(--mk-text);
}
.mtr-fix-tag {
  flex-shrink: 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-66);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-success);
  border: 1px solid var(--color-success);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
}
.mtr-var {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  color: var(--mk-accent);
  background: rgba(200, 155, 224, 0.12);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-4);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .mtr-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
