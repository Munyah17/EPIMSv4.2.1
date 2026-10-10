import type { Handler, Ctx } from './types.js'
import { sendText, sendButtons } from './whatsapp.js'
import { setState, patchNote, deleteSession } from './store.js'
import { getActiveProducts, createClient, createPolicy, addDependant } from './data.js'
import { isEcocashPhone, pickIndex, PAYMENT_METHODS, methodMenu, sendPaymentInstruction, datePlusOneYear } from './helpers.js'

/**
 * The shared payment tail. Every flow in all three menus ends the same
 * way: pick currency -> pick method -> (EcoCash number) -> confirm ->
 * money out. One implementation, entered under a per-flow state prefix
 * ('CPAY', 'CADD', 'CDEP', 'AC', 'AD', 'APAY' ...) so each audience's
 * handler map gets its own state names without duplicating logic.
 *
 * note.flow decides what confirm actually does:
 *   'pay_policy'    charge months x premium on note.payPolicyId
 *   'new_policy'    create a pending policy for note.clientId, charge it
 *   'new_dependant' attach note.dependant to note.depPolicyId, charge it
 */

const S = (prefix: string, s: string) => `${prefix}_${s}`

/** Kick off the tail: record what is being paid and ask the currency. */
export async function startTail(ctx: Ctx, prefix: string, usdAmount: number) {
  await patchNote(ctx.admin, ctx.session, { payUsd: usdAmount })
  await sendButtons(ctx.phone, 'Select payment currency', [
    { id: 'USD', title: 'USD' }, { id: 'ZiG', title: 'ZiG' },
  ])
  return setState(ctx.admin, ctx.session, S(prefix, 'CURRENCY'))
}

export function makeTail(prefix: string): Record<string, Handler> {
  const currency: Handler = async ({ input, phone, session, admin }) => {
    if (input !== 'USD' && input !== 'ZiG') return sendText(phone, 'Please select one of the currencies above.')
    await patchNote(admin, session, { currency: input })
    await sendText(phone, `Select payment method\n\n${methodMenu(input.toLowerCase())}`)
    return setState(admin, session, S(prefix, 'METHOD'))
  }

  const method: Handler = async ({ input, phone, session, admin }) => {
    const key = String(session.note.currency ?? 'USD').toLowerCase()
    const pick = pickIndex(input, PAYMENT_METHODS[key].length)
    if (pick === null) return sendText(phone, 'Please select one of the payment methods above.')
    await patchNote(admin, session, { methodIndex: pick, method: PAYMENT_METHODS[key][pick] })
    if (pick === 0) {
      await sendText(phone, 'Enter the EcoCash number to charge (077XXXXXXXX or 2637XXXXXXXX)')
      return setState(admin, session, S(prefix, 'ECOCASH'))
    }
    await summary(phone, session)
    return setState(admin, session, S(prefix, 'CONFIRM'))
  }

  const ecocash: Handler = async ({ input, phone, session, admin }) => {
    if (!isEcocashPhone(input)) return sendText(phone, 'Please enter a valid EcoCash number (077XXXXXXXX or 2637XXXXXXXX).')
    await patchNote(admin, session, { ecocashNumber: input.trim() })
    await summary(phone, session)
    return setState(admin, session, S(prefix, 'CONFIRM'))
  }

  const confirm: Handler = async (ctx) => {
    const { input, phone, session, admin } = ctx
    if (input !== 'pay' && input !== 'cancel') return sendText(phone, 'Please choose one of the buttons above.')
    if (input === 'cancel') {
      await deleteSession(admin, session)
      return sendText(phone, 'Cancelled.')
    }

    const n = session.note
    const currency = (n.currency as 'USD' | 'ZiG') ?? 'USD'
    const methodIndex = Number(n.methodIndex ?? 1)
    const ecocashNumber = n.ecocashNumber as string | undefined

    // Work out what is being paid for and which policy row paynow's
    // webhook must reconcile this reference against.
    let policyId: string
    let description: string
    let refStem: string

    if (n.flow === 'new_client_policy') {
      // Agent onboarding a brand-new client: the person and their first
      // policy commit together at payment confirm — not mid-wizard, so a
      // cancelled flow never leaves a half-made client behind.
      const client = await createClient(admin, {
        name: String(n.name), nationalId: String(n.nationalId), phone: String(n.clientPhone ?? phone),
        email: n.email as string | undefined, dob: n.dob as string | undefined,
        agentId: n.agentId as string | undefined,
      })
      n.clientId = client.id
      await patchNote(admin, session, { clientId: client.id, clientName: client.name })
      n.flow = 'new_policy'
    }

    if (n.flow === 'new_policy') {
      const product = (await getActiveProducts(admin)).find(p => p.id === n.productId)
      if (!product || !n.clientId) {
        await deleteSession(admin, session)
        return sendText(phone, 'That product is no longer available — your session has been reset.')
      }
      const { start, end } = datePlusOneYear()
      const policy = await createPolicy(admin, {
        clientId: String(n.clientId), product, paymentMethod: String(n.method ?? ''),
        agentId: n.agentId as string | undefined, startDate: start, endDate: end,
      })
      policyId = policy.id
      refStem = policy.policyNumber
      description = `${policy.policyNumber} premium`
      await sendText(phone, `Policy ${policy.policyNumber} (${product.name}) created — pending first payment.`)
    } else if (n.flow === 'new_dependant') {
      const dep = n.dependant as Record<string, unknown> | undefined
      if (!dep || !n.depPolicyId) {
        await deleteSession(admin, session)
        return sendText(phone, 'Something is missing from the dependant details — your session has been reset.')
      }
      await addDependant(admin, String(n.depPolicyId), dep)
      policyId = String(n.depPolicyId)
      refStem = `${n.depPolicyNumber}-DEP`
      description = `${n.depPolicyNumber} dependant premium`
      await sendText(phone, `${dep.name} has been added to policy ${n.depPolicyNumber} — pending first premium.`)
    } else {
      // pay_policy — months already folded into payUsd by the caller.
      if (!n.payPolicyId) {
        await deleteSession(admin, session)
        return sendText(phone, 'No policy selected — your session has been reset.')
      }
      policyId = String(n.payPolicyId)
      refStem = String(n.payPolicyNumber)
      description = `${n.payPolicyNumber} premium (${n.months ?? 1} month${Number(n.months) === 1 ? '' : 's'})`
    }

    await sendPaymentInstruction({
      admin, phone, policyId,
      reference: `${refStem}-${Date.now().toString(36).toUpperCase()}`,
      usdAmount: Number(n.payUsd ?? 0), currency, methodIndex, ecocashNumber,
      origin: 'https://portal.motions.co.zw', description,
    })
    return deleteSession(admin, session)
  }

  async function summary(phone: string, session: Ctx['session']) {
    const n = session.note
    await sendButtons(phone,
      `Confirm payment\n\n` +
      `${n.payLabel ?? 'Payment'}: USD ${Number(n.payUsd ?? 0).toFixed(2)}\n` +
      `Currency: ${n.currency}\nMethod: ${n.method}${n.ecocashNumber ? ` (${n.ecocashNumber})` : ''}`,
      [{ id: 'pay', title: 'Pay now' }, { id: 'cancel', title: 'Cancel' }])
  }

  return {
    [S(prefix, 'CURRENCY')]: currency,
    [S(prefix, 'METHOD')]: method,
    [S(prefix, 'ECOCASH')]: ecocash,
    [S(prefix, 'CONFIRM')]: confirm,
  }
}
