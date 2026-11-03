const r = await self({ prompt: "Reply with the single word: ok", fork: false, label: "probe" });
return { keys: Object.keys(r), response: (r.response || "").slice(0, 200) };
