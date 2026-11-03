const fs = await import('builtIn:fs').catch(() => null);
return { ok: !!fs };
