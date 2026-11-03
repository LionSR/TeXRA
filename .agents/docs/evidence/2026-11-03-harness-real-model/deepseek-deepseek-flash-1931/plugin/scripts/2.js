const report = {};
for (const spec of ['builtIn:notes', 'builtIn:note', 'builtIn:draft']) {
  try {
    const mod = await import(spec);
    report[spec] = { ok: true, keys: Object.keys(mod) };
  } catch (e) {
    report[spec] = { ok: false, error: String(e && e.message || e) };
  }
}
return report;
