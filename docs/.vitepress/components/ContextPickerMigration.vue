<script setup>
// Frameless before→after of the W2 file-picker merge that this whole migration
// guide exists to explain: the Launcher's Files section used to expose TWO
// separate pickers — "Reference" (.bib / reference papers) and "Auxiliary"
// (.sty / preamble) — whose extensions overlapped and whose split confused new
// users. W2 collapsed them into ONE "Context" group (FILE_SELECT_CONFIGS in
// store.ts). That UI merge is the root cause of every rename on this page:
// referenceFile/auxiliaryFile → contextFiles and {{ ALL_REFERENCES }}/
// {{ ALL_AUXILIARYS }} → {{ ALL_CONTEXTS }}.
//
// Reuses the shared .field/.frow/.f-label/.flist/.fitem picker vocabulary from
// theme/mockup.css (the same markup FileSelectHero renders), so this flips
// cleanly with the docs light/dark theme. Two frameless MockCard shells (the
// legacy state, the unified state) joined by an arrow; no MockupFrame.
import MockCard from './MockCard.vue';
</script>

<template>
  <div class="mockup cpm">
    <div class="cpm-grid">
      <!-- BEFORE: two separate pickers -->
      <MockCard class="cpm-card" title="Files" sub="before W2">
        <div class="files">
          <!-- Reference -->
          <div class="field">
            <div class="frow">
              <span class="f-label"
                ><wa-icon class="lbl-ic" library="texra" name="book"></wa-icon>
                Reference</span
              >
              <div class="acts">
                <span class="act"
                  ><wa-icon library="texra" name="folder-opened"></wa-icon
                ></span>
                <span class="act"
                  ><wa-icon library="texra" name="trash"></wa-icon
                ></span>
                <span class="act"
                  ><wa-icon library="texra" name="add"></wa-icon
                ></span>
              </div>
            </div>
            <div class="flist">
              <div class="fitem">
                <wa-icon
                  class="fi-grip"
                  library="texra"
                  name="ellipsis"
                ></wa-icon>
                <span class="fi-name">references.bib</span>
                <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
              </div>
            </div>
          </div>

          <!-- Auxiliary -->
          <div class="field">
            <div class="frow">
              <span class="f-label"
                ><wa-icon class="lbl-ic" library="texra" name="link"></wa-icon>
                Auxiliary</span
              >
              <div class="acts">
                <span class="act"
                  ><wa-icon library="texra" name="folder-opened"></wa-icon
                ></span>
                <span class="act"
                  ><wa-icon library="texra" name="trash"></wa-icon
                ></span>
                <span class="act"
                  ><wa-icon library="texra" name="add"></wa-icon
                ></span>
              </div>
            </div>
            <div class="flist">
              <div class="fitem">
                <wa-icon
                  class="fi-grip"
                  library="texra"
                  name="ellipsis"
                ></wa-icon>
                <span class="fi-name">preamble.sty</span>
                <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
              </div>
            </div>
          </div>

          <p class="cpm-note">
            Overlapping <code>.tex</code> / <code>.md</code> extensions; which
            group?
          </p>
        </div>
      </MockCard>

      <wa-icon class="cpm-arrow" library="texra" name="arrow-right"></wa-icon>

      <!-- AFTER: one Context picker -->
      <MockCard class="cpm-card cpm-card--after" title="Files" sub="after W2">
        <div class="files">
          <!-- Context -->
          <div class="field">
            <div class="frow">
              <span class="f-label"
                ><wa-icon class="lbl-ic" library="texra" name="book"></wa-icon>
                Context</span
              >
              <div class="acts">
                <span class="act"
                  ><wa-icon library="texra" name="folder-opened"></wa-icon
                ></span>
                <span class="act"
                  ><wa-icon library="texra" name="trash"></wa-icon
                ></span>
                <span class="act"
                  ><wa-icon library="texra" name="add"></wa-icon
                ></span>
              </div>
            </div>
            <div class="flist">
              <div class="fitem">
                <wa-icon
                  class="fi-grip"
                  library="texra"
                  name="ellipsis"
                ></wa-icon>
                <span class="fi-name">references.bib</span>
                <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
              </div>
              <div class="fitem">
                <wa-icon
                  class="fi-grip"
                  library="texra"
                  name="ellipsis"
                ></wa-icon>
                <span class="fi-name">preamble.sty</span>
                <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
              </div>
            </div>
          </div>

          <p class="cpm-note">
            One ordered list →
            <code class="cpm-var">&#123;&#123; ALL_CONTEXTS &#125;&#125;</code>
          </p>
        </div>
      </MockCard>
    </div>
  </div>
</template>

<style scoped>
/* The picker vocabulary (.files/.field/.frow/.f-label/.flist/.fitem/.fi-*) is
   shared and lives in theme/mockup.css. Only the two-up layout, the arrow, and
   the small notes are scoped here. */
.cpm-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: var(--mk-space-10);
}
.cpm-card {
  min-width: 0;
}
.cpm-card .files {
  padding: var(--mk-space-10);
  gap: var(--mk-space-10);
}
.cpm-card--after {
  border-color: var(--mk-accent);
}

.cpm-arrow {
  color: var(--mk-accent);
  font-size: var(--mk-space-22);
  flex-shrink: 0;
}

.cpm-note {
  margin: 0;
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-72);
  line-height: 1.4;
  color: var(--mk-text-faint);
}
.cpm-note code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
}
.cpm-var {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-4);
}

/* Stack vertically on narrow screens; rotate the connector. */
@media (max-width: 640px) {
  .cpm-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .cpm-arrow {
    transform: rotate(90deg);
    justify-self: center;
  }
}
</style>
