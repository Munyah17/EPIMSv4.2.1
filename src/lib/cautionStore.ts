import type { CautionFlag } from '../types'

const KEY = 'tqfy_caution_flags'

function load(): CautionFlag[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}

function save(flags: CautionFlag[]) {
  try { localStorage.setItem(KEY, JSON.stringify(flags)) } catch { /**/ }
}

export const cautionStore = {
  list: (): CautionFlag[] => load(),

  listActive: (): CautionFlag[] => load().filter(f => !f.cleared),

  get: (policyId: string): CautionFlag | undefined => load().find(f => f.policyId === policyId),

  set(flag: CautionFlag): void {
    const flags = load().filter(f => f.policyId !== flag.policyId)
    flags.unshift(flag)
    save(flags)
  },

  update(policyId: string, patch: Partial<CautionFlag>): void {
    const flags = load()
    const idx = flags.findIndex(f => f.policyId === policyId)
    if (idx !== -1) { flags[idx] = { ...flags[idx], ...patch }; save(flags) }
  },

  clear(policyId: string): void {
    this.update(policyId, { cleared: true, clearedAt: new Date().toISOString() })
  },

  clearAll(): void { save([]) },
}
