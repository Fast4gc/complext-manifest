/** Cooldown por usuario, testavel sem o Discord. */

export function createCooldown(seconds) {
  const last = new Map(); // userId -> timestamp (ms)
  const windowMs = Math.max(0, seconds) * 1000;

  return {
    /** true se o usuario pode usar agora; senao, quantos segundos faltam. */
    check(userId) {
      if (windowMs === 0) return { ok: true, retryInSec: 0 };
      const prev = last.get(userId) || 0;
      const elapsed = Date.now() - prev;
      if (elapsed >= windowMs) return { ok: true, retryInSec: 0 };
      return { ok: false, retryInSec: Math.ceil((windowMs - elapsed) / 1000) };
    },
    /** Marca o uso (chamar quando o comando foi aceito). */
    hit(userId) {
      last.set(userId, Date.now());
    },
    /** Testes: limpa o estado. */
    reset() {
      last.clear();
    },
  };
}
