/**
 * Stale-bundle watch.
 *
 * A deploy replaces index.html and the hashed /assets/index-*.js bundle,
 * but anyone who already has the portal open keeps running yesterday's
 * code — including yesterday's message wording. Agents register policies
 * from tabs that have been open for days, so a wording fix shipped in the
 * morning was still being sent by the old bundle that afternoon.
 *
 * The watch fetches index.html every few minutes (and on window focus),
 * compares the deployed bundle name with the one this page is running,
 * and raises APP_UPDATE_EVENT once when they differ. App.tsx turns that
 * into a persistent banner with a reload button — a toast alone would
 * vanish after 15s and the tab would keep sending stale formats.
 *
 * Dev servers reference /src/main.tsx, not an /assets/ bundle, so
 * currentBundle() returns null there and the check silently does
 * nothing — no false "update available" on localhost.
 */

export const APP_UPDATE_EVENT = 'ims:app-update'

const POLL_MS = 10 * 60 * 1000

/** The bundle hash THIS page loaded — read from the module script tag
 *  Vite injects into index.html at build time. */
function currentBundle(): string | null {
  try {
    const el = document.querySelector('script[type="module"]')
    return el?.getAttribute('src')?.match(/assets\/(index-[^.]+\.js)/)?.[1] ?? null
  } catch { return null }
}

/** The bundle hash the deployment is currently serving. */
async function deployedBundle(): Promise<string | null> {
  try {
    const res = await fetch('/', { cache: 'no-store' })
    if (!res.ok) return null
    const html = await res.text()
    return html.match(/assets\/(index-[^.]+\.js)/)?.[1] ?? null
  } catch { return null }
}

let announced = false
let started = false

async function check() {
  if (announced) return
  const mine = currentBundle()
  if (!mine) return // dev server or non-standard shell — nothing to compare
  const deployed = await deployedBundle()
  if (deployed && deployed !== mine) {
    announced = true
    window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT))
  }
}

export function startVersionCheck() {
  if (started || typeof window === 'undefined') return
  started = true
  void check()
  // Focus is the moment a stale tab actually does damage — an agent
  // alt-tabbing back after a deploy registers the next policy on old code.
  window.addEventListener('focus', () => { void check() })
  setInterval(() => { void check() }, POLL_MS)
}
