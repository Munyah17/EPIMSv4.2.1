import { randomUUID } from 'node:crypto'
import type { Handler, Ctx } from '../types.js'
import { sendText, sendButtons } from '../whatsapp.js'
import { setState, patchNote, deleteSession } from '../store.js'
import { getActiveProducts, policiesForClient, pendingPoliciesForClient, createClaim, storeClaimMedia, createDependantRemovalTask, botBillablePremium, completedPaymentsForPolicy } from '../data.js'
import { settlement, defaultCharge } from '../../../../src/lib/paymentAllocation.js'
import { isFullName, isDependantId, parseDob, pickIndex, normalizeNationalId } from '../helpers.js'
import { makeTail, startTail } from '../tail.js'
import { coverLabel } from '../../coverBreakdown.js'
import {
  RELATIONSHIPS, PERSON_CATEGORIES, payablePolicies, claimablePolicies,
  periodLabel, periodNoun, billingCycleMonths, policyLine,
  askAgricultureFields, makeAgricultureHandlers,
} from './flowHelpers.js'

/**
 * Policyholder menu — the Frappe CLIENT_HANDLER_MAP.
 *
 *   1. Make Payment   -> pick policy -> periods -> tail
 *   2. My Policies    -> list / Add New Policy -> tail (creates policy)
 *   3. Renew Policy   -> same paid-allocation path as Make Payment
 *   4. Claims         -> pick policy -> upload document -> claim filed
 *   5. Dependants     -> add / remove / view
 */

const MENU = (u: string) =>
  `Hello${u ? ` ${u}` : ''}! Select an option\n\n` +
  `1. Make Payment\n2. My Policies\n3. Renew Policy\n4. Claims\n5. Dependants\n\n` +
  `Type 'exit' at any point to restart.`

const menu: Handler = async (ctx) => {
  const { input, phone, username, session, admin, contact } = ctx
  if (!contact.client) {
    await deleteSession(admin, session)
    return sendText(phone, 'Your client record could not be found — please contact Motions support.')
  }
  if (input === '1') return payStart(ctx)
  if (input === '2') return viewPolicies(ctx)
  // Renewing IS paying: the shared Paynow webhook advances
  // next_payment_date per period paid and reinstates lapsed policies —
  // so option 3 reuses the same pick-policy flow with a renewal label.
  if (input === '3') return renewStart(ctx)
  if (input === '4') return claimsStart(ctx)
  if (input === '5') return dependantsMenu(ctx)
  return sendText(phone, MENU(username))
}

/* ----------------------------- 1. Make Payment ---------------------------- */

const payStart: Handler = async ({ phone, session, admin, contact }) => {
  const policies = payablePolicies([
    ...(await policiesForClient(admin, contact.client!.id)),
    ...(await pendingPoliciesForClient(admin, contact.client!.id)),
  ])
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'You have no policies that need payment.')
  }
  await sendText(phone, `Select the policy to pay\n\n${policies.map(policyLine).join('\n')}`)
  return setState(admin, session, 'CPAY_POLICY')
}

const renewStart: Handler = async ({ phone, session, admin, contact }) => {
  const policies = payablePolicies(await policiesForClient(admin, contact.client!.id)).filter(p => !p.onceOff)
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'You have no recurring policies to renew.')
  }
  await sendText(phone, `Select the policy to renew\n\n${policies.map(policyLine).join('\n')}`)
  return setState(admin, session, 'CPAY_POLICY')
}

const payPolicy: Handler = async (ctx) => {
  const { input, phone, session, admin, contact } = ctx
  const policies = payablePolicies([
    ...(await policiesForClient(admin, contact.client!.id)),
    ...(await pendingPoliciesForClient(admin, contact.client!.id)),
  ])
  const pick = pickIndex(input, policies.length)
  if (pick === null) return sendText(phone, 'Please select one of the policies above.')
  const p = policies[pick]
  await patchNote(admin, session, { flow: 'pay_policy', payPolicyId: p.id, payPolicyNumber: p.policyNumber, policyPremium: botBillablePremium(p), nextPaymentDate: p.nextPaymentDate, billingCycleMonths: billingCycleMonths(p) })
  if (p.onceOff) {
    await patchNote(admin, session, { months: 1, payLabel: `${p.policyNumber} package term` })
    return startTail(ctx, 'CPAY', botBillablePremium(p))
  }
  await sendText(phone, `How many ${periodNoun(p)}s of ${p.policyNumber} are you paying? (1–12)`)
  return setState(admin, session, 'CPAY_MONTHS')
}

const payMonths: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const periods = Number(input.trim())
  if (!Number.isInteger(periods) || periods < 1 || periods > 12) return sendText(phone, 'Please enter a number between 1 and 12.')
  const perPeriod = Number(session.note.policyPremium ?? 0)
  const pays = session.note.payPolicyId
    ? await completedPaymentsForPolicy(admin, String(session.note.payPolicyId))
    : []
  const cycleMonths = Number(session.note.billingCycleMonths ?? 1)
  const unit = cycleMonths === 12 ? 'year' : 'month'
  const due = settlement(perPeriod, cycleMonths, session.note.nextPaymentDate as string | undefined, pays)
  const amount = defaultCharge(due, periods)
  await patchNote(admin, session, {
    months: periods,
    payLabel: due.isUpgrade && periods === 1
      ? `${session.note.payPolicyNumber} dependant top-up`
      : `${session.note.payPolicyNumber} x ${periods} ${unit}${periods === 1 ? '' : 's'}`,
  })
  return startTail(ctx, 'CPAY', amount)
}

/* ----------------------------- 2. My Policies ----------------------------- */

const viewPolicies: Handler = async ({ phone, session, admin, contact }) => {
  const policies = await policiesForClient(admin, contact.client!.id)
  const list = policies.length
    ? policies.map((p, i) =>
        `(${i + 1}) ${p.policyNumber} — ${p.productName}\nPremium: $${p.premium}${periodLabel(p)} | ${coverLabel(p.productName, p.coverAmount, p.premium)} | Status: ${p.status}` +
        (p.dependants.length ? `\nDependants: ${p.dependants.map(d => d.name).join(', ')}` : '')
      ).join('\n\n')
    : 'You have no policies yet.'
  // Interactive bodies are much shorter than a policy book; send the
  // register as ordinary chunked text, then the action buttons alone.
  await sendText(phone, `Your policies\n\n${list}`)
  await sendButtons(phone, 'What would you like to do?', [
    { id: 'add', title: 'Add New Policy' }, { id: 'menu', title: 'Main Menu' },
  ])
  return setState(admin, session, 'CVIEW_SEL')
}

const viewSel: Handler = async (ctx) => {
  const { input, phone, session, admin, username } = ctx
  if (input === 'menu') {
    await setState(admin, session, 'CLIENT_MENU')
    return sendText(phone, MENU(username))
  }
  if (input !== 'add') return sendText(phone, 'Please choose one of the buttons above.')
  const products = await getActiveProducts(admin)
  if (!products.length) return sendText(phone, 'No products are available right now.')
  await sendText(phone, `Select a product\n\n${products.map((p, i) => `${i + 1}. ${p.name} [$${p.premium}${p.category === 'agriculture' ? '/yr' : '/mo'} — ${coverLabel(p.name, p.coverAmount, p.premium)}]`).join('\n')}`)
  return setState(admin, session, 'CADD_PRODUCT')
}

const addProduct: Handler = async (ctx) => {
  const { input, phone, session, admin, contact } = ctx
  const products = await getActiveProducts(admin)
  const pick = pickIndex(input, products.length)
  if (pick === null) return sendText(phone, 'Please select one of the products above.')
  const p = products[pick]
  const held = [
    ...(await policiesForClient(admin, contact.client!.id)),
    ...(await pendingPoliciesForClient(admin, contact.client!.id)),
  ].find(x => x.productId === p.id && ['pending', 'waiting_period', 'active'].includes(x.status))
  if (held) {
    await sendText(phone,
      `You already have ${held.policyNumber} (${held.status.replace(/_/g, ' ')}) on ${p.name}.\n` +
      `Use Make Payment to settle it, or contact us to change the cover.`)
    return deleteSession(admin, session)
  }
  await patchNote(admin, session, {
    flow: 'new_policy', productId: p.id, clientId: contact.client!.id,
    payLabel: `New policy — ${p.name}`,
  })
  // Health products require the medical declaration — same rule as the
  // portal and the website. Payment only starts once it's on record.
  if (p.category === 'health') {
    await sendButtons(phone,
      `Medical declaration — ${p.name}\n\nDo you have a chronic illness or existing condition? (e.g. diabetes, hypertension, asthma, HIV)`,
      [{ id: 'no', title: 'No' }, { id: 'yes', title: 'Yes' }])
    return setState(admin, session, 'CADD_CHRONIC')
  }
  if (p.category === 'agriculture') return askAgricultureFields(ctx, 'CADD')
  return startTail(ctx, 'CADD', p.premium)
}

const addAgricultureDone: Handler = async (ctx) => {
  const p = (await getActiveProducts(ctx.admin)).find(x => x.id === ctx.session.note.productId)
  if (!p) {
    await deleteSession(ctx.admin, ctx.session)
    return sendText(ctx.phone, 'That product is no longer available — your session has been reset.')
  }
  return startTail(ctx, 'CADD', p.premium)
}

const addChronic: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  if (input !== 'yes' && input !== 'no') return sendText(phone, 'Please choose one of the buttons above.')
  if (input === 'yes') {
    await sendText(phone, 'Please state the chronic condition or treatment (e.g. hypertension — on medication).')
    return setState(admin, session, 'CADD_CHRONIC_DETAILS')
  }
  await patchNote(admin, session, { hasChronic: 'no' })
  const p = (await getActiveProducts(admin)).find(x => x.id === session.note.productId)
  if (!p) { await deleteSession(admin, session); return sendText(phone, 'That product is no longer available — your session has been reset.') }
  return startTail(ctx, 'CADD', p.premium)
}

const addChronicDetails: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const d = input.trim()
  if (d.length < 4 || d.length > 300) return sendText(phone, 'Please state the chronic condition or treatment briefly.')
  await patchNote(admin, session, { hasChronic: 'yes', chronicDetails: d })
  const p = (await getActiveProducts(admin)).find(x => x.id === session.note.productId)
  if (!p) { await deleteSession(admin, session); return sendText(phone, 'That product is no longer available — your session has been reset.') }
  return startTail(ctx, 'CADD', p.premium)
}

/* -------------------------------- 4. Claims ------------------------------- */

const claimsStart: Handler = async ({ phone, session, admin, contact }) => {
  const policies = claimablePolicies(await policiesForClient(admin, contact.client!.id))
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'You have no active or waiting-period policies to claim on.')
  }
  await sendText(phone, `Which policy is the claim for?\n\n${policies.map((p, i) => `${i + 1}. ${p.policyNumber} — ${p.productName}`).join('\n')}`)
  return setState(admin, session, 'CCLAIM_POLICY')
}

const claimPolicy: Handler = async ({ input, phone, session, admin, contact }) => {
  const policies = claimablePolicies(await policiesForClient(admin, contact.client!.id))
  const pick = pickIndex(input, policies.length)
  if (pick === null) return sendText(phone, 'Please select one of the policies above.')
  await patchNote(admin, session, { claimPolicyId: policies[pick].id, claimPolicyNumber: policies[pick].policyNumber })
  await sendText(phone, 'Send a photo or document supporting the claim.')
  return setState(admin, session, 'CCLAIM_DOC')
}

/** The webhook encodes uploads as 'filename: X |||| id: Y' — any other
 *  input here means they typed text instead of attaching a file. */
const claimDoc: Handler = async ({ input, phone, session, admin }) => {
  const m = /^filename: (.+) \|\|\|\| id: (.+)$/.exec(input)
  if (!m) return sendText(phone, 'Please attach the supporting document or photo (or send exit to cancel).')
  const claimId = randomUUID()
  let documentPath: string
  try {
    documentPath = await storeClaimMedia(admin, claimId, m[2], m[1])
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.error(`whatsapp bot: claim attachment failed for ${session.note.claimPolicyNumber}`, detail)
    return sendText(phone, `I could not save that attachment (${detail}). Please send a PDF or a JPG/PNG/WEBP photo under 10MB, or type exit to cancel.`)
  }
  await createClaim(admin, {
    id: claimId,
    policyId: String(session.note.claimPolicyId),
    description: `WhatsApp claim on ${session.note.claimPolicyNumber} — attachment '${m[1]}' (WhatsApp media ${m[2]}).`,
    documents: [documentPath],
  })
  await sendText(phone, `Your claim on ${session.note.claimPolicyNumber} has been filed with the attachment. Our claims team will contact you.`)
  return deleteSession(admin, session)
}

/* ------------------------------- 5. Dependants ---------------------------- */

const dependantsMenu: Handler = async ({ phone, session, admin }) => {
  await sendButtons(phone, 'Dependants', [
    { id: 'add', title: 'Add Dependant' }, { id: 'remove', title: 'Remove' }, { id: 'view', title: 'View' },
  ])
  return setState(admin, session, 'CDEP_MENU')
}

const depMenuSel: Handler = async (ctx) => {
  const { input, phone, session, admin, contact } = ctx
  if (input === 'add') {
    await sendText(phone, "*Please only register your relatives.*\n\nEnter the dependant's full name.")
    return setState(admin, session, 'CDEP_NAME')
  }
  if (input === 'remove') {
    await sendText(phone, 'Enter the national ID of the dependant to remove.')
    return setState(admin, session, 'CDEP_REMOVE_ID')
  }
  if (input === 'view') {
    const policies = await policiesForClient(admin, contact.client!.id)
    const deps = policies.flatMap(p => p.dependants.map(d => `${d.name} — ${d.relationship ?? 'dependant'} (on ${p.policyNumber})`))
    await deleteSession(admin, session)
    return sendText(phone, deps.length ? `Your dependants\n\n${deps.join('\n')}` : 'You have no dependants on any policy.')
  }
  return sendText(phone, 'Please choose one of the buttons above.')
}

const depRemoveId: Handler = async ({ input, phone, session, admin, contact }) => {
  if (!isDependantId(input)) return sendText(phone, "Please enter the dependant's ID or birth record number.")
  const wanted = normalizeNationalId(input)
  const policies = await policiesForClient(admin, contact.client!.id)
  const policy = policies.find(p => p.dependants.some(d => normalizeNationalId(String(d.nationalId ?? '')) === wanted))
  const dependant = policy?.dependants.find(d => normalizeNationalId(String(d.nationalId ?? '')) === wanted)
  if (!policy || !dependant) return sendText(phone, "That dependant was not found on your policies (send 'exit' to cancel).")
  await createDependantRemovalTask(admin, { client: contact.client!, policy, dependant })
  await deleteSession(admin, session)
  return sendText(phone, 'Your request to remove the dependant has been sent to our team. Cover remains unchanged until staff approve the removal.')
}

const depName: Handler = async ({ input, phone, session, admin }) => {
  if (!isFullName(input)) return sendText(phone, 'Please enter a valid full name.')
  await patchNote(admin, session, { depName: input.trim() })
  await sendText(phone, "Enter the dependant's national ID or birth record number (e.g. 083837373U23)")
  return setState(admin, session, 'CDEP_ID')
}

const depId: Handler = async ({ input, phone, session, admin }) => {
  if (!isDependantId(input)) return sendText(phone, "Please enter the dependant's ID or birth record number.")
  await patchNote(admin, session, { depNationalId: normalizeNationalId(input) })
  await sendButtons(phone, "Select the dependant's gender", [
    { id: 'male', title: 'Male' }, { id: 'female', title: 'Female' }, { id: 'other', title: 'Other' },
  ])
  return setState(admin, session, 'CDEP_GENDER')
}

const depGender: Handler = async ({ input, phone, session, admin }) => {
  if (input === 'other') {
    await sendText(phone, "Type the dependant's preferred gender")
    return setState(admin, session, 'CDEP_GENDER_OTHER')
  }
  if (input !== 'male' && input !== 'female') return sendText(phone, 'Please choose one of the buttons above.')
  await patchNote(admin, session, { depGender: input })
  await sendText(phone, "Enter the dependant's date of birth (e.g. 26-05-2000)")
  return setState(admin, session, 'CDEP_DOB')
}

const depGenderOther: Handler = async ({ input, phone, session, admin }) => {
  const g = input.trim()
  if (g.length < 2 || g.length > 40) return sendText(phone, 'Please type a valid gender.')
  await patchNote(admin, session, { depGender: g })
  await sendText(phone, "Enter the dependant's date of birth (e.g. 26-05-2000)")
  return setState(admin, session, 'CDEP_DOB')
}

const depDob: Handler = async ({ input, phone, session, admin }) => {
  const iso = parseDob(input)
  if (!iso) return sendText(phone, 'Please enter a valid date in DD-MM-YYYY format.')
  await patchNote(admin, session, { depDob: iso })
  await sendText(phone, `Select the relationship\n\n${RELATIONSHIPS.map((r, i) => `${i + 1}. ${r}`).join('\n')}`)
  return setState(admin, session, 'CDEP_REL')
}

const depRel: Handler = async ({ input, phone, session, admin, contact }) => {
  const pick = pickIndex(input, RELATIONSHIPS.length)
  if (pick === null) return sendText(phone, 'Please select one of the relationships above.')
  await patchNote(admin, session, { depRelationship: RELATIONSHIPS[pick] })
  const policies = claimablePolicies(await policiesForClient(admin, contact.client!.id))
    .filter(p => PERSON_CATEGORIES.includes(p.productCategory))
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'You have no person-cover policy to attach a dependant to.')
  }
  await sendText(phone, `Which of your policies should cover them?\n\n${policies.map((p, i) => `${i + 1}. ${p.policyNumber} — ${p.productName}`).join('\n')}`)
  return setState(admin, session, 'CDEP_POLICY')
}

const depPolicy: Handler = async ({ input, phone, session, admin, contact }) => {
  const policies = claimablePolicies(await policiesForClient(admin, contact.client!.id))
    .filter(p => PERSON_CATEGORIES.includes(p.productCategory))
  const pick = pickIndex(input, policies.length)
  if (pick === null) return sendText(phone, 'Please select one of the policies above.')
  const p = policies[pick]
  await patchNote(admin, session, {
    depPolicyId: p.id, depPolicyNumber: p.policyNumber, depPolicyCategory: p.productCategory,
  })
  const products = (await getActiveProducts(admin)).filter(x => x.category === p.productCategory)
  if (!products.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'No matching dependant cover is available for that policy right now.')
  }
  await sendText(phone, `Select the dependant's cover\n\n${products.map((x, i) => `${i + 1}. ${x.name} [$${x.premium}/mo]`).join('\n')}`)
  return setState(admin, session, 'CDEP_PRODUCT')
}

const depProduct: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const products = (await getActiveProducts(admin)).filter(x => x.category === session.note.depPolicyCategory)
  const pick = pickIndex(input, products.length)
  if (pick === null) return sendText(phone, 'Please select one of the products above.')
  const p = products[pick]
  await patchNote(admin, session, { depProductId: p.id })
  if (p.category === 'health') {
    await sendButtons(phone,
      `Medical declaration — ${p.name}\n\nDoes ${session.note.depName} have a chronic illness or existing condition?`,
      [{ id: 'no', title: 'No' }, { id: 'yes', title: 'Yes' }])
    return setState(admin, session, 'CDEP_CHRONIC')
  }
  return commitDependantPick(ctx)
}

const depChronic: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  if (input !== 'yes' && input !== 'no') return sendText(phone, 'Please choose one of the buttons above.')
  if (input === 'yes') {
    await sendText(phone, `Please state ${session.note.depName}'s chronic condition or treatment.`)
    return setState(admin, session, 'CDEP_CHRONIC_DETAILS')
  }
  await patchNote(admin, session, { depChronic: 'no' })
  return commitDependantPick(ctx)
}

const depChronicDetails: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const d = input.trim()
  if (d.length < 4 || d.length > 300) return sendText(phone, 'Please state the chronic condition or treatment briefly.')
  await patchNote(admin, session, { depChronic: 'yes', depChronicDetails: d })
  return commitDependantPick(ctx)
}

async function commitDependantPick(ctx: Ctx) {
  const { session, admin, phone } = ctx
  const products = await getActiveProducts(admin)
  const p = products.find(x => x.id === session.note.depProductId)
  if (!p) {
    await deleteSession(admin, session)
    return sendText(phone, 'That cover is no longer available — your session has been reset.')
  }
  const n = session.note
  await patchNote(admin, session, {
    flow: 'new_dependant',
    dependant: {
      name: n.depName, nationalId: n.depNationalId, dob: n.depDob, gender: n.depGender,
      relationship: n.depRelationship, productId: p.id, productName: p.name,
      premium: p.premium, coverAmount: p.coverAmount,
      ...(n.depChronic === 'yes' ? { hasChronicIllness: true, chronicIllnessDetails: n.depChronicDetails } : {}),
    },
    payLabel: `Dependant cover — ${n.depName} (${p.name})`,
  })
  return startTail(ctx, 'CDEP', p.premium)
}

export const CLIENT_HANDLERS: Record<string, Handler> = {
  CLIENT_MENU: menu,
  CPAY_POLICY: payPolicy,
  CPAY_MONTHS: payMonths,
  ...makeTail('CPAY'),
  CVIEW_SEL: viewSel,
  CADD_PRODUCT: addProduct, CADD_CHRONIC: addChronic, CADD_CHRONIC_DETAILS: addChronicDetails,
  ...makeAgricultureHandlers('CADD', addAgricultureDone),
  ...makeTail('CADD'),
  CCLAIM_POLICY: claimPolicy,
  CCLAIM_DOC: claimDoc,
  CDEP_MENU: depMenuSel,
  CDEP_REMOVE_ID: depRemoveId,
  CDEP_NAME: depName,
  CDEP_ID: depId,
  CDEP_GENDER: depGender,
  CDEP_GENDER_OTHER: depGenderOther,
  CDEP_DOB: depDob,
  CDEP_REL: depRel,
  CDEP_POLICY: depPolicy,
  CDEP_PRODUCT: depProduct,
  CDEP_CHRONIC: depChronic,
  CDEP_CHRONIC_DETAILS: depChronicDetails,
  ...makeTail('CDEP'),
}
