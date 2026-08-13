<script setup>
// The modular building block behind the focused figure cards (DoctorReport,
// AgentYaml, tool-call logs, tool/category panels, …): a frameless bordered card
// with an inline mono header. Composes the shared .mk-card / .mk-card-head
// classes from theme/mockup.css, so a page or component gets the card + header
// by COMPOSITION instead of re-writing the markup and CSS each time.
//
// Inline-header sibling of MockupPanel (which draws a header strip). Pass
// title/icon/sub for the standard header, or use the `head` slot for a custom
// one; the default slot is the card body. Any extra class/style you put on
// <MockCard> merges onto the .mk-card root (single-root attribute inheritance),
// so a consumer can still scope body-specific tweaks.
defineProps({
  title: { type: String, default: '' },
  icon: { type: String, default: '' }, // wa-icon name (texra library)
  sub: { type: String, default: '' }, // muted sub-line after the title
});
</script>

<template>
  <div class="mockup mk-card" role="group" :aria-label="title || undefined">
    <div v-if="title || icon || sub || $slots.head" class="mk-card-head">
      <wa-icon
        v-if="icon"
        class="mk-card-head-ic"
        library="texra"
        :name="icon"
      ></wa-icon>
      <span v-if="title" class="mk-card-title">{{ title }}</span>
      <span v-if="sub" class="mk-card-sub">{{ sub }}</span>
      <slot name="head" />
    </div>
    <slot />
  </div>
</template>
