<script setup>
// Frameless Dashboard → Tools surface. The latex-tools page repeatedly tells the
// reader to "check Dashboard → Tools" (the Overview table maps each tool to its
// backing software, and the prose calls out the two status states each shows:
// warning "Not Found" vs check "Available") but never shows that panel. This
// renders it: a "Tools" section header + grouped tool cards (LaTeX, Computation)
// each carrying the tool icon, name, backing binary, and a status pill.
//
// Tool names + icons mirror the Overview table on the page verbatim. Status is a
// believable static mix — most Available, texcount Not Found with an Install hint
// — to show both states the prose describes.
//
// Root carries `.mockup`, so the --mk-* token block + the litStyles alias bridge
// (--color-*, --brand, --wa-*) resolve here and the panel flips with the theme.
const groups = [
  {
    label: 'LaTeX',
    icon: 'file-code',
    tools: [
      {
        icon: 'symbol-keyword',
        name: 'latexindent',
        backend: 'latexindent · tex-fmt',
        status: 'available',
      },
      {
        icon: 'diff-single',
        name: 'latexdiff',
        backend: 'latexdiff',
        status: 'available',
      },
      {
        icon: 'symbol-numeric',
        name: 'texcount',
        backend: 'not on PATH',
        status: 'not-found',
      },
      {
        icon: 'file-media',
        name: 'Figure Extraction',
        backend: 'built-in',
        status: 'available',
      },
      {
        icon: 'symbol-structure',
        name: 'TikZ',
        backend: 'latexmk · GraphicsMagick',
        status: 'available',
      },
      {
        icon: 'book',
        name: 'Bibliography',
        backend: 'built-in',
        status: 'available',
      },
    ],
  },
  {
    label: 'Computation',
    icon: 'symbol-operator',
    tools: [
      {
        icon: 'symbol-operator',
        name: 'Wolfram',
        backend: 'wolframscript',
        status: 'available',
      },
    ],
  },
];
</script>

<template>
  <div class="mockup tsp" role="group" aria-label="Dashboard Tools panel">
    <div class="tsp-head">
      <wa-icon
        class="tsp-head-ic"
        library="texra"
        name="screwdriver-wrench"
      ></wa-icon>
      <span class="tsp-head-name">Tools</span>
      <span class="tsp-head-sub">Dashboard</span>
    </div>

    <div v-for="g in groups" :key="g.label" class="tsp-group">
      <div class="tsp-group-label">
        <wa-icon class="tsp-group-ic" library="texra" :name="g.icon"></wa-icon>
        {{ g.label }}
      </div>
      <div class="tsp-grid">
        <section v-for="t in g.tools" :key="t.name" class="tsp-card">
          <wa-icon class="tsp-card-ic" library="texra" :name="t.icon"></wa-icon>
          <div class="tsp-card-body">
            <span class="tsp-card-name">{{ t.name }}</span>
            <span class="tsp-card-backend">{{ t.backend }}</span>
          </div>
          <div class="tsp-card-status">
            <span class="tsp-pill" :class="`tsp-pill--${t.status}`">
              <wa-icon
                library="texra"
                :name="t.status === 'available' ? 'check' : 'warning'"
              ></wa-icon>
              {{ t.status === 'available' ? 'Available' : 'Not Found' }}
            </span>
            <span v-if="t.status === 'not-found'" class="tsp-install">
              Install
            </span>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone card. Every token resolves from `.mockup` (theme/mockup.css). */
.tsp {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
  overflow: hidden;
}

.tsp-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-10);
  border-bottom: 1px solid var(--mk-border);
  font-family: var(--vp-font-family-mono);
}
.tsp-head-ic {
  font-size: var(--mk-space-14);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.tsp-head-name {
  font-size: var(--mk-fs-84);
  font-weight: 700;
  color: var(--mk-text);
}
.tsp-head-sub {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  margin-left: auto;
}

.tsp-group {
  margin-top: var(--mk-space-12);
}
.tsp-group-label {
  display: flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-66);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  margin-bottom: var(--mk-space-8);
}
.tsp-group-ic {
  font-size: var(--mk-space-11);
  color: var(--color-text-tertiary);
}

.tsp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--mk-space-8);
}

.tsp-card {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-8) var(--mk-space-10);
}
.tsp-card-ic {
  font-size: var(--mk-space-16);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.tsp-card-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.tsp-card-name {
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-text);
}
.tsp-card-backend {
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-mono);
}

.tsp-card-status {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  flex-shrink: 0;
}
.tsp-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-68);
  font-weight: 600;
  white-space: nowrap;
}
.tsp-pill wa-icon {
  font-size: var(--mk-space-11);
}
.tsp-pill--available {
  color: var(--color-success);
}
.tsp-pill--not-found {
  color: var(--color-warning);
}
.tsp-install {
  font-size: var(--mk-fs-66);
  font-weight: 600;
  color: var(--color-text-link);
  cursor: pointer;
}
.tsp-install:hover {
  text-decoration: underline;
}
</style>
