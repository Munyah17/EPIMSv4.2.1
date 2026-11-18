import type { Handler, Ctx, BotPolicy } from '../types.js'
import { sendText } from '../whatsapp.js'
import { setState, patchNote } from '../store.js'
import { botBillablePremium } from '../data.js'
import { pickIndex } from '../helpers.js'

/** Shared policy-menu rules for the client and agent bots. */
export const RELATIONSHIPS = ['Spouse', 'Child', 'Parent', 'Sibling', 'Grandparent', 'Grandchild', 'Other']
export const HECTARAGE_OPTIONS = [0.5, 1, 1.5, 2, 2.5, 3]
export const PERSON_CATEGORIES = ['funeral', 'life', 'health', 'accident']
const CLOSED_STATUSES = ['cancelled', 'expired']

export const payablePolicies = (policies: BotPolicy[]) =>
  policies.filter(p => !CLOSED_STATUSES.includes(p.status) && (!p.onceOff || p.status === 'pending'))

export const claimablePolicies = (policies: BotPolicy[]) =>
  policies.filter(p => p.status === 'active' || p.status === 'waiting_period')

export const periodLabel = (p: BotPolicy) => p.onceOff ? '/term' : p.productCategory === 'agriculture' ? '/yr' : '/mo'
export const periodNoun = (p: BotPolicy) => p.productCategory === 'agriculture' ? 'year' : 'month'
export const billingCycleMonths = (p: BotPolicy) => p.productCategory === 'agriculture' ? 12 : 1
export const policyLine = (p: BotPolicy, i: number) =>
  `${i + 1}. ${p.policyNumber} — ${p.productName} ($${botBillablePremium(p).toFixed(2)}${periodLabel(p)}, ${p.status})`

export async function askAgricultureFields(ctx: Ctx, prefix: string) {
  await sendText(ctx.phone, 'Enter the grower registration number, or 1 to skip.')
  return setState(ctx.admin, ctx.session, `${prefix}_AGRI_GROWER`)
}

/** Three agriculture states, wired back to the caller's next step after
 *  hectarage is stored. Grower number and contractor are optional in the
 *  portal; planted area is mandatory. */
export function makeAgricultureHandlers(prefix: string, next: (ctx: Ctx) => Promise<void>): Record<string, Handler> {
  const grower: Handler = async (ctx) => {
    const value = ctx.input.trim()
    if (value !== '1' && (value.length < 3 || value.length > 40)) return sendText(ctx.phone, 'Enter a valid grower number, or 1 to skip.')
    await patchNote(ctx.admin, ctx.session, { growerNumber: value === '1' ? undefined : value })
    await sendText(ctx.phone, 'Enter the contractor / merchant name, or 1 to skip.')
    return setState(ctx.admin, ctx.session, `${prefix}_AGRI_CONTRACTOR`)
  }
  const contractor: Handler = async (ctx) => {
    const value = ctx.input.trim()
    if (value !== '1' && (value.length < 2 || value.length > 80)) return sendText(ctx.phone, 'Enter a valid contractor name, or 1 to skip.')
    await patchNote(ctx.admin, ctx.session, { contractor: value === '1' ? undefined : value })
    await sendText(ctx.phone, `Select the planted hectarage\n\n${HECTARAGE_OPTIONS.map((h, i) => `${i + 1}. ${h} ha`).join('\n')}`)
    return setState(ctx.admin, ctx.session, `${prefix}_AGRI_HECTARAGE`)
  }
  const hectarage: Handler = async (ctx) => {
    const pick = pickIndex(ctx.input, HECTARAGE_OPTIONS.length)
    if (pick === null) return sendText(ctx.phone, 'Please select one of the hectarage options above.')
    await patchNote(ctx.admin, ctx.session, { hectarage: HECTARAGE_OPTIONS[pick] })
    return next(ctx)
  }
  return {
    [`${prefix}_AGRI_GROWER`]: grower,
    [`${prefix}_AGRI_CONTRACTOR`]: contractor,
    [`${prefix}_AGRI_HECTARAGE`]: hectarage,
  }
}
