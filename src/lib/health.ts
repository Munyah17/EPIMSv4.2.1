export type OpType = 'read' | 'write' | 'delete' | 'notify'
export type DataSource = 'supabase' | 'local' | 'api'

export interface DbOp {
  id: string
  ts: number
  type: OpType
  table: string
  success: boolean
  duration: number
  source: DataSource
  detail?: string
}

class HealthTracker {
  private ops: DbOp[] = []
  private readonly boot = Date.now()
  private listeners = new Set<() => void>()

  record(op: Omit<DbOp, 'id'>) {
    this.ops.push({ ...op, id: Math.random().toString(36).slice(2, 9) })
    if (this.ops.length > 300) this.ops.shift()
    this.listeners.forEach(fn => fn())
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  reset() {
    this.ops = []
    this.listeners.forEach(fn => fn())
  }

  get stats() {
    const all = this.ops
    const recent50 = all.slice(-50)
    const sb = recent50.filter(o => o.source === 'supabase')
    const reads = recent50.filter(o => o.type === 'read')
    const writes = recent50.filter(o => o.type === 'write' || o.type === 'delete')

    const pct = (arr: DbOp[]) =>
      arr.length ? Math.round(arr.filter(o => o.success).length / arr.length * 100) : 100

    const sbConnected = sb.some(o => o.success)
    const avgMs = recent50.length
      ? Math.round(recent50.reduce((s, o) => s + o.duration, 0) / recent50.length)
      : 0

    // Gateway sends are tracked as their own integration op — an Afrosoft
    // outage shows up in the log and its own metric, but must NOT drag the
    // Supabase numbers down with it: the database being fine while SMS is
    // dead is exactly what this page exists to distinguish.
    const smsOps = recent50.filter(o => o.table === 'sms-gateway')
    const lastSms = smsOps.length ? smsOps[smsOps.length - 1] : null
    // An SMS gateway failure degrades the whole picture the same way a DB
    // failure does — the office cannot operate blind while texts fail.
    const smsPct = pct(smsOps)

    const writeOk = pct(writes)
    const readOk = pct(reads)
    // On dev origins the SMS gateway is intentionally unreachable (the
    // /api functions don't exist), so dev SMS failures must NOT affect
    // overall health status — same reasoning as localhost, every spelling.
    const dev = isDevOrigin()
    const overall: 'healthy' | 'degraded' | 'offline' =
      !sbConnected ? 'degraded'
      : writeOk < 50 || readOk < 50 || (!dev && smsOps.length > 0 && smsPct < 50) ? 'offline'
      : writeOk < 90 || readOk < 90 || (!dev && smsOps.length > 0 && smsPct < 90) ? 'degraded'
      : 'healthy'

    return {
      uptime: Date.now() - this.boot,
      totalOps: all.length,
      sbConnected,
      sbSuccessPct: pct(sb),
      readSuccessPct: readOk,
      writeSuccessPct: writeOk,
      avgMs,
      overall,
      localMode: !sbConnected,
      smsOpsCount: smsOps.length,
      smsSuccessPct: smsPct,
      smsLastOk: lastSms ? lastSms.success : null,
      smsLastDetail: lastSms?.detail ?? null,
      recent: [...all].reverse().slice(0, 25),
    }
  }
}

/**
 * Is this page running somewhere that can NEVER have the /api functions —
 * a vite dev server, a LAN IP, a .local name — rather than the deployed
 * portal? The old checks matched 'localhost' literally, which is why the
 * "SMS SERVICE PROBLEM" banner kept coming back on 127.0.0.1, LAN IPs
 * (192.168.x.x), .local names and preview proxies: every one of those
 * failed the check and was treated as a real gateway outage.
 */
export function isDevOrigin(): boolean {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname.toLowerCase()
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true
  if (/\.(local|localhost|test|internal|lan)$/.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  // A bare hostname (no dot — "desktop-pc", "printserver") is never a
  // public deployment.
  if (!h.includes('.')) return true
  return false
}

export const health = new HealthTracker()
