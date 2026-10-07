/** Rate limit simples em memória, por chave. */
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of buckets) {
    if (now - bucket.windowStart > 60_000) buckets.delete(id);
  }
}, 60_000).unref();

export function allow(id, limitPerMinute) {
  const now = Date.now();
  let bucket = buckets.get(id);
  if (!bucket || now - bucket.windowStart > 60_000) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(id, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limitPerMinute;
}
