import type { Handler, Ctx } from '../types.js'
import { sendText, sendButtons } from '../whatsapp.js'
import { setState, patchNote, deleteSession } from '../store.js'
import { getActiveProducts, policiesForClient, createClaim } from '../data.js'
import { isFullName, isNationalId, parseDob, pickIndex } from '../helpers.js'
import { makeTail, startTail } from '../tail.js'
import { coverLabel } from '../../coverBreakdown.js'

/**
 * Policyholder menu — the Frappe CLIENT_HANDLER_MAP.
 *
 *   1. Make Payment   -> pick policy -> months -> tail
 *   2. My Policies    -> list / Add New Policy -> tail (creates policy)
 *   3. Renew Policy   -> stub (same as Frappe)
 *   4. Claims         -> pick policy -> upload document -> claim filed
 *   5. Dependants     -> add / remove / view
 */

const RELATIONSHIPS = ['Spouse', 'Child', 'Parent', 'Sibling', 'Grandparent', 'Grandchild', 'Other']

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
  const policies = await policiesForClient(admin, contact.client!.id)
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'You have no policies to pay for.')
  }
  await sendText(phone, `Select the policy to pay\n\n${policies.map((p, i) => `${i + 1}. ${p.policyNumber} — ${p.productName} ($${p.premium}/month, ${p.status})`).join('\n')}`)
  return setState(admin, session, 'CPAY_POLICY')
}

const renewStart: Handler = async ({ phone, session, admin, contact }) => {
  const policies = await policiesForClient(admin, contact.client!.id)
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'You have no policies to renew.')
  }
  await sendText(phone, `Select the policy to renew\n\n${policies.map((p, i) => `${i + 1}. ${p.policyNumber} — ${p.productName} ($${p.premium}/month, ${p.status})`).join('\n')}`)
  return setState(admin, session, 'CPAY_POLICY')
}

const payPolicy: Handler = async ({ input, phone, session, admin, contact }) => {
  const policies = await policiesForClient(admin, contact.client!.id)
  const pick = pickIndex(input, policies.length)
  if (pick === null) return sendText(phone, 'Please select one of the policies above.')
  const p = policies[pick]
  await patchNote(admin, session, { flow: 'pay_policy', payPolicyId: p.id, payPolicyNumber: p.policyNumber, policyPremium: p.premium })
  await sendText(phone, `How many months of ${p.policyNumber} are you paying? (1–12)`)
  return setState(admin, session, 'CPAY_MONTHS')
}

const payMonths: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const months = Number(input.trim())
  if (!Number.isInteger(months) || months < 1 || months > 12) return sendText(phone, 'Please enter a number between 1 and 12.')
  const amount = Number(session.note.policyPremium ?? 0) * months
  await patchNote(admin, session, {
    months,
    payLabel: `${session.note.payPolicyNumber} x ${months} month${months === 1 ? '' : 's'}`,
  })
  return startTail(ctx, 'CPAY', amount)
}

/* ----------------------------- 2. My Policies ----------------------------- */

const viewPolicies: Handler = async ({ phone, session, admin, contact }) => {
  const policies = await policiesForClient(admin, contact.client!.id)
  const list = policies.length
    ? policies.map((p, i) =>
        `(${i + 1}) ${p.policyNumber} — ${p.productName}\nPremium: $${p.premium}/month | ${coverLabel(p.productName, p.coverAmount)} | Status: ${p.status}` +
        (p.dependants.length ? `\nDependants: ${p.dependants.map(d => d.name).join(', ')}` : '')
      ).join('\n\n')
    : 'You have no policies yet.'
  await sendButtons(phone, `Your policies\n\n${list}`, [
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
  await sendText(phone, `Select a product\n\n${products.map((p, i) => `${i + 1}. ${p.name} [$${p.premium}/month — ${coverLabel(p.name, p.coverAmount)}]`).join('\n')}`)
  return setState(admin, session, 'CADD_PRODUCT')
}

const addProduct: Handler = async (ctx) => {
  const { input, phone, session, admin, contact } = ctx
  const products = await getActiveProducts(admin)
  const pick = pickIndex(input, products.length)
  if (pick === null) return sendText(phone, 'Please select one of the products above.')
  const p = products[pick]
  await patchNote(admin, session, {
    flow: 'new_policy', productId: p.id, clientId: contact.client!.id,
    payLabel: `New policy — ${p.name}`,
  })
  return startTail(ctx, 'CADD', p.premium)
}

/* -------------------------------- 4. Claims ------------------------------- */

const claimsStart: Handler = async ({ phone, session, admin, contact }) => {
  const policies = await policiesForClient(admin, contact.client!.id)
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'You have no policies to claim on.')
  }
  await sendText(phone, `Which policy is the claim for?\n\n${policies.map((p, i) => `${i + 1}. ${p.policyNumber} — ${p.productName}`).join('\n')}`)
  return setState(admin, session, 'CCLAIM_POLICY')
}

const claimPolicy: Handler = async ({ input, phone, session, admin, contact }) => {
  const policies = await policiesForClient(admin, contact.client!.id)
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
  await createClaim(admin, {
    policyId: String(session.note.claimPolicyId),
    description: `WhatsApp claim on ${session.note.claimPolicyNumber} — document '${m[1]}' (WhatsApp media ${m[2]}).`,
    documents: [{ name: m[1], whatsappMediaId: m[2] }],
  })
  await sendText(phone, `Your claim on ${session.note.claimPolicyNumber} has been filed. Our claims team will contact you.`)
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
  if (!isNationalId(input)) return sendText(phone, 'Please enter a valid national ID.')
  const policies = await policiesForClient(admin, contact.client!.id)
  const found = policies.some(p => p.dependants.some(d => d.nationalId === input.trim()))
  if (!found) return sendText(phone, "That dependant was not found on your policies (send 'exit' to cancel).")
  await deleteSession(admin, session)
  return sendText(phone, 'Your request to remove the dependant has been sent. Our team will confirm once it is processed.')
}

const depName: Handler = async ({ input, phone, session, admin }) => {
  if (!isFullName(input)) return sendText(phone, 'Please enter a valid full name.')
  await patchNote(admin, session, { depName: input.trim() })
  await sendText(phone, "Enter the dependant's national ID (e.g. 083837373U23)")
  return setState(admin, session, 'CDEP_ID')
}

const depId: Handler = async ({ input, phone, session, admin }) => {
  if (!isNationalId(input)) return sendText(phone, 'Please enter a valid national ID.')
  await patchNote(admin, session, { depNationalId: input.trim() })
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
  const policies = await policiesForClient(admin, contact.client!.id)
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'You have no policy to attach a dependant to.')
  }
  await sendText(phone, `Which of your policies should cover them?\n\n${policies.map((p, i) => `${i + 1}. ${p.policyNumber} — ${p.productName}`).join('\n')}`)
  return setState(admin, session, 'CDEP_POLICY')
}

const depPolicy: Handler = async ({ input, phone, session, admin, contact }) => {
  const policies = await policiesForClient(admin, contact.client!.id)
  const pick = pickIndex(input, policies.length)
  if (pick === null) return sendText(phone, 'Please select one of the policies above.')
  await patchNote(admin, session, { depPolicyId: policies[pick].id, depPolicyNumber: policies[pick].policyNumber })
  const products = await getActiveProducts(admin)
  await sendText(phone, `Select the dependant's cover\n\n${products.map((p, i) => `${i + 1}. ${p.name} [$${p.premium}/month]`).join('\n')}`)
  return setState(admin, session, 'CDEP_PRODUCT')
}

const depProduct: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const products = await getActiveProducts(admin)
  const pick = pickIndex(input, products.length)
  if (pick === null) return sendText(phone, 'Please select one of the products above.')
  const p = products[pick]
  const n = session.note
  await patchNote(admin, session, {
    flow: 'new_dependant',
    dependant: {
      name: n.depName, nationalId: n.depNationalId, dob: n.depDob, gender: n.depGender,
      relationship: n.depRelationship, productId: p.id, productName: p.name,
      premium: p.premium, coverAmount: p.coverAmount,
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
  CADD_PRODUCT: addProduct,
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
  ...makeTail('CDEP'),
}
