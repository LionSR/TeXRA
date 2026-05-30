<script setup>
// Frameless live-checklist figure for the ProgressBoard guide. The prose
// describes a three-state lifecycle (Pending -> In Progress -> Completed) but
// the reader cannot see the visual difference between the states. This lifts
// the exact Todos panel out of the VS Code chrome and shows all three states
// at once, adding the 'pending' variant the embedded hero never shows.
//
// Directly reuses the .panel / .panel-sum / .panel-body / .todos / .todo /
// .td-ic / .td-sp primitives from theme/mockup.css (rendered in GuideIntroHero);
// the only scoped addition is the muted dot for a pending (not-yet-started) item.
// Root carries `.mockup` so all --mk-* tokens resolve and it flips with the theme.
</script>

<template>
  <div class="mockup tdl" role="group" aria-label="Todo list lifecycle">
    <div class="panel">
      <div class="panel-sum">
        <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
        Todos (2/4)
      </div>
      <div class="panel-body todos">
        <div class="todo done">
          <wa-icon class="td-ic" library="texra" name="check"></wa-icon
          ><span class="td-tx">Ground the literature</span>
        </div>
        <div class="todo done">
          <wa-icon class="td-ic" library="texra" name="check"></wa-icon
          ><span class="td-tx">Derive the concurrence</span>
        </div>
        <div class="todo prog">
          <span class="td-sp"></span
          ><span class="td-tx">Formalize subadditivity in Lean</span>
        </div>
        <div class="todo pending">
          <span class="tdl-dot"></span
          ><span class="td-tx">Write the discussion</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Frameless card shell — mirrors the other frameless figures on this page. */
.tdl {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  max-width: var(--mk-size-420, 420px);
  overflow: hidden;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
}
/* Drop the panel's bottom rule — the card border already closes the figure. */
.tdl .panel {
  border-bottom: none;
}
/* Pending: a hollow muted dot, the not-yet-started counterpart to the
   green check (done) and spinner (in progress) the panel already shows. */
.tdl .todo.pending .td-tx {
  color: var(--color-text-secondary);
}
.tdl-dot {
  width: var(--mk-space-11);
  height: var(--mk-space-11);
  flex-shrink: 0;
  border: 2px solid var(--mk-text-faint);
  border-radius: 50%;
  opacity: 0.7;
}
</style>
