<script setup>
import MockCard from './MockCard.vue';

// Frameless before/after slice for the troubleshooting page's "XML parsing
// issues" fix: TeXRA wraps workflow output in <documents>…</documents>, and an
// LLM that drops the trailing </documents> breaks extraction. The reader is
// told to open r0/output.xml and add the missing tag — far clearer shown than
// described, so this card stacks the two states:
//   • Broken — the closing </documents> is absent (flagged in red).
//   • Fixed  — the same snippet with </documents> restored (marked green ins).
// Mono diff-surface vocabulary (.dl/.kw/.ins) mirrors CompareHero; the root
// carries `.mockup` (via MockCard) so the shared --mk-* tokens resolve and the
// card flips cleanly between the docs light / dark themes.
</script>

<template>
  <MockCard class="xml-repair" icon="file-code" title="r0/output.xml">
    <div class="xr-states">
      <!-- Broken state -->
      <section class="xr-state">
        <header class="xr-h">
          <span class="xr-badge xr-badge--bad">
            <wa-icon library="texra" name="error"></wa-icon>Extraction fails
          </span>
        </header>
        <div class="diff-surface">
          <div class="dl"><span class="kw">&lt;documents&gt;</span></div>
          <div class="dl">
            <span class="ind">&nbsp;&nbsp;</span
            ><span class="kw">&lt;document </span
            ><span class="attr">name</span>=<span class="str">"draft.tex"</span
            ><span class="kw">&gt;</span>
          </div>
          <div class="dl">
            <span class="ind">&nbsp;&nbsp;&nbsp;&nbsp;</span
            ><span class="cmt">… revised LaTeX …</span>
          </div>
          <div class="dl">
            <span class="ind">&nbsp;&nbsp;</span
            ><span class="kw">&lt;/document&gt;</span>
          </div>
          <div class="dl dl-miss">
            <span class="miss-mark"
              ><wa-icon library="texra" name="warning"></wa-icon
            ></span>
            <span class="miss-text">missing &lt;/documents&gt;</span>
          </div>
        </div>
      </section>

      <div class="xr-rule" role="separator" aria-hidden="true"></div>

      <!-- Fixed state -->
      <section class="xr-state">
        <header class="xr-h">
          <span class="xr-badge xr-badge--ok">
            <wa-icon library="texra" name="check"></wa-icon>Closing tag restored
          </span>
        </header>
        <div class="diff-surface">
          <div class="dl"><span class="kw">&lt;documents&gt;</span></div>
          <div class="dl">
            <span class="ind">&nbsp;&nbsp;</span
            ><span class="kw">&lt;document </span
            ><span class="attr">name</span>=<span class="str">"draft.tex"</span
            ><span class="kw">&gt;</span>
          </div>
          <div class="dl">
            <span class="ind">&nbsp;&nbsp;&nbsp;&nbsp;</span
            ><span class="cmt">… revised LaTeX …</span>
          </div>
          <div class="dl">
            <span class="ind">&nbsp;&nbsp;</span
            ><span class="kw">&lt;/document&gt;</span>
          </div>
          <div class="dl dl-add">
            <ins><span class="kw">&lt;/documents&gt;</span></ins>
          </div>
        </div>
      </section>
    </div>
  </MockCard>
</template>

<style scoped>
/* Card shell + mono header come from <MockCard>; only the two stacked states
   and the mono XML surface are scoped here. */
.xr-states {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
}
.xr-state {
  min-width: 0;
}
.xr-h {
  display: flex;
  margin-bottom: var(--mk-space-4);
}
.xr-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  border-radius: var(--mk-radius-pill);
  padding: 1px var(--mk-space-8);
}
.xr-badge--bad {
  color: var(--mk-del-text);
  background: color-mix(in srgb, var(--color-error) 14%, transparent);
}
.xr-badge--ok {
  color: var(--mk-ins-text);
  background: color-mix(in srgb, var(--color-success) 16%, transparent);
}
.xr-badge wa-icon {
  font-size: var(--mk-fs-74);
}

.xr-rule {
  height: 1px;
  background: var(--mk-border);
  margin: var(--mk-space-2) 0;
}

/* Mono XML surface — mirrors CompareHero's .diff-surface / .dl token styling. */
.diff-surface {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-82);
  color: var(--wa-color-text-normal);
  line-height: 1.7;
}
.dl {
  display: flex;
  align-items: baseline;
  white-space: pre-wrap;
  padding: 0 var(--mk-space-6);
  border-radius: var(--mk-radius-xs);
}
.ind {
  white-space: pre;
}
.attr {
  color: var(--mk-syn-fn);
}
.str {
  color: var(--mk-ins-text);
}

/* The flagged missing-tag line in the broken state. */
.dl-miss {
  align-items: center;
  gap: var(--mk-space-6);
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
}
.miss-mark {
  display: inline-flex;
  color: var(--mk-del-text);
  font-size: var(--mk-fs-74);
}
.miss-text {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-72);
  font-weight: 600;
  color: var(--mk-del-text);
}

/* The restored tag in the fixed state — green ins, like CompareHero. */
.dl-add {
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
}
.dl-add ins {
  background: color-mix(in srgb, var(--color-success) 32%, transparent);
  color: var(--mk-ins-text);
  text-decoration: none;
  border-radius: var(--mk-radius-xs);
  padding: 0 1px;
}
.dl-add ins .kw {
  color: inherit;
}
</style>
