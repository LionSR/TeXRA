<script setup>
// Thin terminal-window primitive — MockCard's sibling for figures that ARE
// terminal output. Renders the shared faux-macOS titlebar (.mk-term-bar:
// traffic-light dots + mono command title), the recessed mono body
// (.mk-term-body) around the default slot, and a bottom strip (.mk-term-hint)
// only when a #hint slot is passed. All chrome comes from the shared
// .mk-term-* classes in theme/mockup.css, so the card flips with the docs
// light / dark theme; consumers keep only their own row vocabulary.
//
// Deliberately prop-poor: `title` is the command being demonstrated (the house
// convention for .mk-term-title) and `ariaLabel` defaults to it. No density or
// variant props — prompt lines, tool rows, tables, and diff hunks belong to
// the consumer. Frameless comparisons (ConfigPrecedenceStack) should NOT be
// forced through this primitive.
defineProps({
  title: { type: String, required: true },
  ariaLabel: { type: String, default: '' },
});
</script>

<template>
  <div
    class="mockup mk-term-card"
    role="group"
    :aria-label="ariaLabel || title"
  >
    <div class="mk-term-bar">
      <span class="mk-term-light mk-term-light--r"></span>
      <span class="mk-term-light mk-term-light--y"></span>
      <span class="mk-term-light mk-term-light--g"></span>
      <span class="mk-term-title">{{ title }}</span>
    </div>
    <div class="mk-term-body"><slot /></div>
    <div v-if="$slots.hint" class="mk-term-hint"><slot name="hint" /></div>
  </div>
</template>
