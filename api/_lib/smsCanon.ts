import type { SupabaseClient } from '@supabase/supabase-js'
import { policyRegisteredSms, isTobaccoFieldToFloor, fieldToFloorCoverLine } from '../../src/lib/smsText.js'
import { resolveSmsText, smsVarMoney } from '../../src/lib/smsTemplates.js'

/**
 * The stale-format trapdoor.
 *
 * Message wording lives in the browser bundle, and agents keep tabs open
 * for days — so a deploy that fixes the wording does not reach a stale
 * tab, which keeps composing last week's text. Reload banners ask
 * politely; this makes the answer at the border: every SMS/WhatsApp send
 * funnels through the server, and if the text still carries the OLD
 * registration shape — "<POLICY> registered." / "<POLICY> reg." — it is
 * rebuilt from the policy record with the CURRENT shared builder and
 * that is what goes out.
 *
 * Fail-open on every doubt: a lookup miss, a bad row, an exception —
 * the original text is sent. A stale-format text still beats none.
 */

// "NAME TOB0576 reg./registered./Reg. …" — every registration-shaped
// variant is rebuilt from the record. A text that is already canonical
// rewrites to itself (a wasted lookup, not a wrong send) — matching
// everything is what makes this immune to any bundle's wording. Needs
// LETTERS+DIGITS so "ACME FARM reg." (client/group registrations with
// no policy number) can never false-positive.
const STALE_REGISTRATION = /\b([A-Z]{2,8}\d{3,})\s+reg(?:istered)?\./i

// Office envelopes carry an event label — "REG: ", "PAYMENT: " etc.
// Keep whatever prefix the caller used so office copies still announce
// themselves.
const ENVELOPE_PREFIX = /^\s*([A-Z]{3,14}):\s+/

export async function canonicalizeSmsText(admin: SupabaseClient | null, message: string): Promise<string> {
  try {
    const m = message.match(STALE_REGISTRATION)
    if (!m || !admin) return message
    const policyNumber = m[1].toUpperCase()

    const { data: p } = await admin
      .from('policies')
      .select('*')
      .eq('policy_number', policyNumber)
      .maybeSingle()
    if (!p) return message
    const row = p as Record<string, unknown>

    let client: { name?: string; phone?: string } | null = null
    if (row.client_id) {
      const { data: c } = await admin
        .from('clients')
        .select('name, phone')
        .eq('id', row.client_id)
        .maybeSingle()
      client = c
    }

    const clientName = String(row.client_name ?? client?.name ?? 'Customer')
    const productName = String(row.product_name ?? row.productName ?? 'Policy')
    const premium = Number(row.premium ?? 0)
    const paymentMethod = (row.payment_method ?? row.paymentMethod) as string | undefined
    // Rebuild through the template resolver, not just the default builder —
    // otherwise the border would overwrite a staff-authored registration
    // template with the stock wording on every send. Without a matching
    // template this produces the identical standard text as before.
    const canonical = await resolveSmsText(admin, 'registration_confirmation', {
      productId: (row.product_id ?? row.productId) as string | undefined,
      vars: {
        clientName,
        policyNumber,
        productName,
        coverAmount: smsVarMoney(Number(row.cover_amount ?? row.coverAmount ?? 0)),
        coverLine: isTobaccoFieldToFloor(productName)
          ? fieldToFloorCoverLine(productName, premium)
          : smsVarMoney(Number(row.cover_amount ?? row.coverAmount ?? 0)),
        premium: smsVarMoney(premium),
        // Tobacco texts carry no period label — see smsText.ts.
        period: isTobaccoFieldToFloor(productName) ? '' : '/yr',
        premiumWithPeriod: isTobaccoFieldToFloor(productName) ? smsVarMoney(premium) : `${smsVarMoney(premium)}/yr`,
        paymentMethod,
      },
      fallback: policyRegisteredSms({
        clientName,
        policyNumber,
        productName,
        productCategory: (row.product_category ?? row.productCategory) as string | undefined,
        coverAmount: Number(row.cover_amount ?? row.coverAmount ?? 0),
        premium,
        paymentMethod,
        clientPhone: client?.phone,
      }),
    })

    const prefix = message.match(ENVELOPE_PREFIX)?.[1]
    return `${prefix ? `${prefix}: ` : ''}${canonical}`
  } catch {
    return message
  }
}
