export const read = fn => { try { return fn(); } catch { return undefined; } };
