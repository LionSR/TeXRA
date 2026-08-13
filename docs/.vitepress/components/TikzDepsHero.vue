<script setup>
// Frameless TikZ-pipeline dependency checklist. The "TikZ Figures" section on
// latex-tools.md enumerates three requirements — latexmk (or pdflatex),
// GraphicsMagick (or ImageMagick), Ghostscript — each "checked on Dashboard →
// Tools". The prose implies a partial-readiness state (some present, one
// missing) that gates whether TikZ extraction works. This renders that as a
// compact 3-row status list: a mixed Available / Not Found mix so the reader
// sees both states and the "install this before TikZ works" message at a glance.
//
// This is a smaller, single-group instance of ToolStatusPanel's vocabulary
// (same icon + name + backend + status-pill row, same green-check / amber-warning
// / Install-link treatment) so the two status figures on this page read as one
// family. Root carries `.mockup`, so the --mk-* token block + litStyles alias
// bridge (--color-*, --brand, --wa-*) resolve here and the panel flips with the
// docs theme.
const deps = [
  {
    icon: 'symbol-structure',
    name: 'latexmk',
    backend: 'or pdflatex — compiles each tikzpicture',
    status: 'available',
  },
  {
    icon: 'file-media',
    name: 'GraphicsMagick',
    backend: 'or ImageMagick — PDF → image conversion',
    status: 'available',
  },
  {
    icon: 'symbol-operator',
    name: 'Ghostscript',
    backend: 'PDF processing',
    status: 'not-found',
  },
];
</script>

<template>
  <div
    class="mockup mk-card tdh"
    role="group"
    aria-label="TikZ pipeline dependencies"
  >
    <div class="mk-card-head tdh-head">
      <wa-icon
        class="mk-card-head-ic tdh-head-ic"
        library="texra"
        name="symbol-structure"
      ></wa-icon>
      <span class="mk-card-title tdh-head-name">TikZ pipeline</span>
      <span class="mk-card-sub tdh-head-sub">Dashboard → Tools</span>
    </div>

    <div class="tdh-list">
      <section v-for="d in deps" :key="d.name" class="tdh-row">
        <wa-icon class="tdh-row-ic" library="texra" :name="d.icon"></wa-icon>
        <div class="tdh-row-body">
          <span class="tdh-row-name">{{ d.name }}</span>
          <span class="tdh-row-backend">{{ d.backend }}</span>
        </div>
        <div class="tdh-row-status">
          <span class="tdh-pill" :class="`tdh-pill--${d.status}`">
            <wa-icon
              library="texra"
              :name="d.status === 'available' ? 'check' : 'warning'"
            ></wa-icon>
            {{ d.status === 'available' ? 'Available' : 'Not Found' }}
          </span>
          <span v-if="d.status === 'not-found'" class="tdh-install">
            Install guide
          </span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* Card shell + inline mono header inherit from the shared .mk-card* family
   (theme/mockup.css). Only divergent values are set here — mirrors
   ToolStatusPanel so the two status figures on this page match. */
.tdh {
  margin: var(--mk-space-16) 0;
}

.tdh-head {
  padding-bottom: var(--mk-space-10);
  margin-bottom: 0;
}
.tdh-head-ic {
  font-size: var(--mk-space-14);
}
.tdh-head-name {
  font-size: var(--mk-fs-84);
  font-weight: 700;
}
.tdh-head-sub {
  margin-left: auto;
}

.tdh-list {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  margin-top: var(--mk-space-12);
}

.tdh-row {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  min-width: 0;
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-8) var(--mk-space-10);
}
.tdh-row-ic {
  font-size: var(--mk-space-16);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.tdh-row-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.tdh-row-name {
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-text);
  font-family: var(--vp-font-family-mono);
}
.tdh-row-backend {
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
}

.tdh-row-status {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  flex-shrink: 0;
}
.tdh-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-68);
  font-weight: 600;
  white-space: nowrap;
}
.tdh-pill wa-icon {
  font-size: var(--mk-space-11);
}
.tdh-pill--available {
  color: var(--color-success);
}
.tdh-pill--not-found {
  color: var(--color-warning);
}
.tdh-install {
  font-size: var(--mk-fs-66);
  font-weight: 600;
  color: var(--color-text-link);
  cursor: pointer;
}
.tdh-install:hover {
  text-decoration: underline;
}
</style>
