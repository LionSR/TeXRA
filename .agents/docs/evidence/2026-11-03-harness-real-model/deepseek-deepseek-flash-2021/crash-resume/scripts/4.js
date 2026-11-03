try {
  const r = await self("Reply with the single word: ok", { fork: false, label: "probe" });
  return { ok: true, response: (r.response || "").slice(0, 200) };
} catch (e) {
  return { ok: false, name: e.name, msg: e.message, str: String(e) };
}
