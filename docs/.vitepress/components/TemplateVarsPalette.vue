<script setup>
// Frameless template-variable palette for guide/custom-agents.md's "Using
// Variables in Prompts" section. The source prose enumerates the built-in Jinja2
// variables as two flat bullet lists, which buries the naming convention that
// actually makes them memorable: `*_FILE` is a path, `*_CONTENT` is that file's
// text, `ALL_*` is every selected file as one XML bundle, and `LIST_OF_*` is the
// same set as a comma-separated path list. Rendering them as grouped mono token
// chips — each tagged with its kind — turns the namespace into a map the reader
// scans once instead of parsing twelve bullets.
//
// Card shell + inline mono header come by COMPOSITION from <MockCard>, and the
// per-row kind chip from <StatusPill>, so the `--mk-*` colour + dimensional
// tokens resolve here and the palette flips cleanly between the docs light / dark
// themes. Tokens are stored as plain strings (`{{ … }}` in the DATA, not the
// template markup) so Vue renders the braces literally instead of interpolating.
import MockCard from './MockCard.vue';
import StatusPill from './StatusPill.vue';

// kind → StatusPill variant: path=blue, text=neutral, xml=purple, csv=green.
// The kind label is the lesson — it teaches the *_FILE / *_CONTENT / ALL_ /
// LIST_OF_ convention at a glance.
const groups = [
  {
    label: 'One selected file',
    vars: [
      {
        token: '{{ INSTRUCTION }}',
        kind: 'text',
        gloss: 'What you typed in the Instruction box',
      },
      { token: '{{ INPUT_FILE }}', kind: 'path', gloss: 'Primary input file' },
      {
        token: '{{ INPUT_CONTENT }}',
        kind: 'text',
        gloss: 'Text of the primary input file',
      },
      {
        token: '{{ CONTEXT_FILE }}',
        kind: 'path',
        gloss: 'Primary context file',
      },
      {
        token: '{{ CONTEXT_CONTENT }}',
        kind: 'text',
        gloss: 'Text of the primary context file',
      },
      {
        token: '{{ EDITED_FILE }}',
        kind: 'path',
        gloss: 'Edited file (used in merge)',
      },
      {
        token: '{{ EDITED_CONTENT }}',
        kind: 'text',
        gloss: 'Text of the edited file',
      },
      {
        token: '{{ MEDIA_FILE }}',
        kind: 'path',
        gloss: 'Primary media file — content sent separately',
      },
    ],
  },
  {
    label: 'Every selected file',
    vars: [
      {
        token: '{{ ALL_INPUTS }}',
        kind: 'xml',
        gloss: 'All inputs wrapped in <document> tags',
      },
      {
        token: '{{ ALL_CONTEXTS }}',
        kind: 'xml',
        gloss: 'All context files as the same XML',
      },
      {
        token: '{{ LIST_OF_ALL_INPUTS }}',
        kind: 'csv',
        gloss: 'Comma-separated input paths',
      },
      {
        token: '{{ LIST_OF_ALL_CONTEXTS }}',
        kind: 'csv',
        gloss: 'Comma-separated context paths',
      },
    ],
  },
];

const KIND_VARIANT = {
  path: 'info',
  text: 'neutral',
  xml: 'accent',
  csv: 'success',
};
</script>

<template>
  <MockCard class="tv" icon="symbol-variable" title="Built-in prompt variables">
    <div v-for="(g, gi) in groups" :key="gi" class="tv-group">
      <div class="tv-glabel">{{ g.label }}</div>
      <div class="tv-rows">
        <div v-for="(v, i) in g.vars" :key="i" class="tv-row">
          <code class="tv-token">{{ v.token }}</code>
          <StatusPill
            class="tv-kind"
            :variant="KIND_VARIANT[v.kind]"
            shape="chip"
            >{{ v.kind }}</StatusPill
          >
          <span class="tv-gloss">{{ v.gloss }}</span>
        </div>
      </div>
    </div>
  </MockCard>
</template>

<style scoped>
.tv-group + .tv-group {
  margin-top: var(--mk-space-12);
}
.tv-glabel {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-66);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  margin-bottom: var(--mk-space-6);
}
.tv-rows {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-3);
}
.tv-row {
  display: grid;
  grid-template-columns: minmax(0, max-content) auto 1fr;
  align-items: center;
  gap: var(--mk-space-8);
  padding: var(--mk-space-2) 0;
}
.tv-token {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-6);
  white-space: nowrap;
}
.tv-kind {
  justify-self: start;
}
.tv-gloss {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-76);
  color: var(--color-text-secondary);
  min-width: 0;
}
/* Stack token + gloss on narrow screens; the kind chip rides with the token. */
@media (max-width: 560px) {
  .tv-row {
    grid-template-columns: 1fr auto;
  }
  .tv-gloss {
    grid-column: 1 / -1;
  }
}
</style>
