/**
 * "Get the latest version" button for when a deploy has just landed and a
 * tab is still serving the old bundle.
 *
 * Three stale layers are cleared before reloading:
 *  - the Cache Storage API (service-worker/asset caches),
 *  - the `tqfy_cache_*` read-through cache (real rows, safe to drop — they
 *    are refetched from Supabase on load; auth tokens are NOT touched, so
 *    the user is never signed out by a refresh),
 *  - the browser's cache for index.html itself, defeated by a
 *    `?refresh=timestamp` query param — a plain reload() can still serve a
 *    stale HTML shell pointing at an old hashed bundle.
 */
export async function hardRefresh(): Promise<void> {
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('tqfy_cache_')) localStorage.removeItem(key)
    }
  } finally {
    const url = new URL(window.location.href)
    url.searchParams.set('refresh', String(Date.now()))
    window.location.href = url.toString()
  }
}
