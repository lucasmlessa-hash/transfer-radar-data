// Public source requests get bounded retries. A persistent failure still
// reaches the caller's health report; old data is never labelled verified.
export async function fetchPage(url, {
  headers, tries = 3, timeoutMs = 20000, ok = () => true,
  fetcher = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await wait(1500 * attempt);
    try {
      const res = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        error.permanent = ![403, 408, 429].includes(res.status) && res.status < 500;
        await res.body?.cancel();
        throw error;
      }
      const body = await res.text();
      if (!ok(body)) throw new Error('response did not parse');
      return body;
    } catch (error) {
      if (error.permanent) throw error;
      last = error;
    }
  }
  throw last;
}
