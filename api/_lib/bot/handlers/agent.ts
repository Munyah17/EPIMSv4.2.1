import type { Handler, Ctx, BotProduct } from '../types.js'
import { sendText, sendButtons } from '../whatsapp.js'
import { setState, patchNote, deleteSession } from '../store.js'
import { getActiveProducts, policiesForClient, clientByNationalId, clientsOfAgent, commissionForAgent } from '../data.js'
import { isFullName, isNationalId, isDependantId, isEmail, parseDob, pickIndex, normalizeNationalId } from '../helpers.js'
import { makeTail, startTail } from '../tail.js'
import { coverLabel } from '../../coverBreakdown.js'

/**
 * Agent menu — the Frappe AGENT_HANDLER_MAP.
 *
 *   1. Add New Client     -> personal wizard -> product -> tail
 *                          (client + policy commit at confirm, agent_id set)
 *   2. Add New Dependant  -> sponsor's national ID -> sponsor policy ->
 *                          dependant wizard -> tail
 *   3. View Clients       -> clients where agent_id = their profile
 *   4. Commission         -> stub (same as Frappe)
 *   5. Make Payment       -> client's national ID -> policy -> months -> tail
 */

const RELATIONSHIPS = ['Spouse', 'Child', 'Parent', 'Sibling', 'Grandparent', 'Grandchild', 'Other']

const MENU = (u: string) =>
  `Hello${u ? ` ${u}` : ''}! Select an option\n\n` +
  `1. Add New Client\n2. Add New Dependant\n3. My Clients\n4. Commission\n5. Make Payment\n\n` +
  `Type 'exit' at any point to restart.`

const menu: Handler = async (ctx) => {
  const { input, phone, username, session, admin } = ctx
  if (input === '1') {
    await sendText(phone, "Enter the client's full name (e.g. Joe Marowa)")
    return setState(admin, session, 'AC_NAME')
  }
  if (input === '2') {
    await sendText(phone, "Enter the sponsering policy holder's national ID (e.g. 083837373U23)")
    return setState(admin, session, 'AD_HOLDER_ID')
  }
  if (input === '3') return viewClients(ctx)
  if (input === '4') return commission(ctx)
  if (input === '5') {
    await sendText(phone, "Enter the client's national ID (e.g. 083837373U23)")
    return setState(admin, session, 'APAY_ID')
  }
  return sendText(phone, MENU(username))
}

/* ------------------------- 1. Add New Client ------------------------------ */

const acName: Handler = async ({ input, phone, session, admin }) => {
  if (!isFullName(input)) return sendText(phone, 'Please enter a valid full name.')
  await patchNote(admin, session, { name: input.trim() })
  await sendText(phone, "Enter the client's national ID (e.g. 083837373U23)")
  return setState(admin, session, 'AC_ID')
}

const acId: Handler = async ({ input, phone, session, admin }) => {
  if (!isNationalId(input)) return sendText(phone, 'Please enter a valid national ID (e.g. 632118532K12).')
  if (await clientByNationalId(admin, input)) return sendText(phone, 'A client with that national ID already exists (send exit to cancel).')
  await patchNote(admin, session, { nationalId: normalizeNationalId(input) })
  await sendButtons(phone, "Select the client's gender", [
    { id: 'male', title: 'Male' }, { id: 'female', title: 'Female' }, { id: 'other', title: 'Other' },
  ])
  return setState(admin, session, 'AC_GENDER')
}

const acGender: Handler = async ({ input, phone, session, admin }) => {
  if (input === 'other') {
    await sendText(phone, "Type the client's preferred gender")
    return setState(admin, session, 'AC_GENDER_OTHER')
  }
  if (input !== 'male' && input !== 'female') return sendText(phone, 'Please choose one of the buttons above.')
  await patchNote(admin, session, { gender: input })
  await sendText(phone, "Enter the client's date of birth (e.g. 26-05-1990)")
  return setState(admin, session, 'AC_DOB')
}

const acGenderOther: Handler = async ({ input, phone, session, admin }) => {
  const g = input.trim()
  if (g.length < 2 || g.length > 40) return sendText(phone, 'Please type a valid gender.')
  await patchNote(admin, session, { gender: g })
  await sendText(phone, "Enter the client's date of birth (e.g. 26-05-1990)")
  return setState(admin, session, 'AC_DOB')
}

const acDob: Handler = async ({ input, phone, session, admin }) => {
  const iso = parseDob(input)
  if (!iso) return sendText(phone, 'Please enter a valid date in DD-MM-YYYY format.')
  await patchNote(admin, session, { dob: iso })
  await sendText(phone, "Enter the client's email, or 1 to skip")
  return setState(admin, session, 'AC_EMAIL')
}

const acEmail: Handler = async ({ input, phone, session, admin }) => {
  if (input.trim() !== '1') {
    if (!isEmail(input)) return sendText(phone, 'Please enter a valid email address, or 1 to skip.')
    await patchNote(admin, session, { email: input.trim() })
  }
  await sendText(phone, "Enter the client's contact number in international format (e.g. 263775668334)")
  return setState(admin, session, 'AC_PHONE')
}

const acPhone: Handler = async ({ input, phone, session, admin }) => {
  const digits = input.replace(/\D/g, '')
  if (!/^0?\d{9,12}$/.test(digits) && !/^263\d{9}$/.test(digits)) {
    return sendText(phone, 'Please enter a valid phone number.')
  }
  await patchNote(admin, session, { clientPhone: digits })
  const products = await getActiveProducts(admin)
  if (!products.length) {
    await deleteSession(admin, session)
    return sendText(phone, 'No products are available right now.')
  }
  await sendText(phone, `Select a product\n\n${products.map((p, i) => `${i + 1}. ${p.name} [$${p.premium}${p.category === 'agriculture' ? '/yr' : '/mo'} — ${coverLabel(p.name, p.coverAmount, p.premium)}]`).join('\n')}`)
  return setState(admin, session, 'AC_PRODUCT')
}

const acProduct: Handler = async (ctx) => {
  const { input, phone, session, admin, contact } = ctx
  const products = await getActiveProducts(admin)
  const pick = pickIndex(input, products.length)
  if (pick === null) return sendText(phone, 'Please select one of the products above.')
  const p = products[pick]
  await patchNote(admin, session, {
    flow: 'new_client_policy', productId: p.id, agentId: contact.agent!.id,
    payLabel: `New client — ${session.note.name} (${p.name})`,
  })
  // Health products require the medical declaration — same as the
  // portal and the client bot. It precedes payment: nobody charges a
  // health premium to a person whose declaration isn't on file.
  if (p.category === 'health') {
    await sendButtons(phone,
      `Medical declaration — ${p.name}\n\nDoes ${session.note.name} have a chronic illness or existing condition? (e.g. diabetes, hypertension, asthma, HIV)`,
      [{ id: 'no', title: 'No' }, { id: 'yes', title: 'Yes' }])
    return setState(admin, session, 'AC_CHRONIC')
  }
  return startTail(ctx, 'AC', p.premium)
}

const acChronic: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  if (input !== 'yes' && input !== 'no') return sendText(phone, 'Please choose one of the buttons above.')
  if (input === 'yes') {
    await sendText(phone, `Please state the client's chronic condition or treatment (e.g. hypertension — on medication).`)
    return setState(admin, session, 'AC_CHRONIC_DETAILS')
  }
  await patchNote(admin, session, { hasChronic: 'no' })
  const products = await getActiveProducts(admin)
  const p = products.find(x => x.id === session.note.productId)
  return startTail(ctx, 'AC', p?.premium ?? 0)
}

const acChronicDetails: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const d = input.trim()
  if (d.length < 4 || d.length > 300) return sendText(phone, 'Please state the chronic condition or treatment briefly.')
  await patchNote(admin, session, { hasChronic: 'yes', chronicDetails: d })
  const products = await getActiveProducts(admin)
  const p = products.find(x => x.id === session.note.productId)
  return startTail(ctx, 'AC', p?.premium ?? 0)
}

/* ------------------------- 2. Add New Dependant ---------------------------- */

const adHolderId: Handler = async ({ input, phone, session, admin }) => {
  if (!isNationalId(input)) return sendText(phone, 'Please enter a valid national ID (e.g. 632118532K12).')
  const holder = await clientByNationalId(admin, input)
  if (!holder) return sendText(phone, 'No client with that national ID exists (send exit to cancel).')
  await patchNote(admin, session, { holderId: holder.id, holderName: holder.name })
  const policies = await policiesForClient(admin, holder.id)
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, `${holder.name} has no policies to attach a dependant to.`)
  }
  await sendText(phone, `Select ${holder.name}'s policy\n\n${policies.map((p, i) => `${i + 1}. ${p.policyNumber} — ${p.productName}`).join('\n')}`)
  return setState(admin, session, 'AD_POLICY')
}

const adPolicy: Handler = async ({ input, phone, session, admin }) => {
  const policies = await policiesForClient(admin, String(session.note.holderId))
  const pick = pickIndex(input, policies.length)
  if (pick === null) return sendText(phone, 'Please select one of the policies above.')
  await patchNote(admin, session, { depPolicyId: policies[pick].id, depPolicyNumber: policies[pick].policyNumber })
  await sendText(phone, "*Please only register relatives.*\n\nEnter the dependant's full name.")
  return setState(admin, session, 'AD_NAME')
}

const adName: Handler = async ({ input, phone, session, admin }) => {
  if (!isFullName(input)) return sendText(phone, 'Please enter a valid full name.')
  await patchNote(admin, session, { depName: input.trim() })
  await sendText(phone, "Enter the dependant's national ID or birth record number")
  return setState(admin, session, 'AD_ID')
}

const adId: Handler = async ({ input, phone, session, admin }) => {
  if (!isDependantId(input)) return sendText(phone, "Please enter the dependant's ID or birth record number.")
  await patchNote(admin, session, { depNationalId: normalizeNationalId(input) })
  await sendButtons(phone, "Select the dependant's gender", [
    { id: 'male', title: 'Male' }, { id: 'female', title: 'Female' }, { id: 'other', title: 'Other' },
  ])
  return setState(admin, session, 'AD_GENDER')
}

const adGender: Handler = async ({ input, phone, session, admin }) => {
  if (input === 'other') {
    await sendText(phone, "Type the dependant's preferred gender")
    return setState(admin, session, 'AD_GENDER_OTHER')
  }
  if (input !== 'male' && input !== 'female') return sendText(phone, 'Please choose one of the buttons above.')
  await patchNote(admin, session, { depGender: input })
  await sendText(phone, "Enter the dependant's date of birth (e.g. 26-05-2000)")
  return setState(admin, session, 'AD_DOB')
}

const adGenderOther: Handler = async ({ input, phone, session, admin }) => {
  const g = input.trim()
  if (g.length < 2 || g.length > 40) return sendText(phone, 'Please type a valid gender.')
  await patchNote(admin, session, { depGender: g })
  await sendText(phone, "Enter the dependant's date of birth (e.g. 26-05-2000)")
  return setState(admin, session, 'AD_DOB')
}

const adDob: Handler = async ({ input, phone, session, admin }) => {
  const iso = parseDob(input)
  if (!iso) return sendText(phone, 'Please enter a valid date in DD-MM-YYYY format.')
  await patchNote(admin, session, { depDob: iso })
  await sendText(phone, `Select the relationship\n\n${RELATIONSHIPS.map((r, i) => `${i + 1}. ${r}`).join('\n')}`)
  return setState(admin, session, 'AD_REL')
}

const adRel: Handler = async ({ input, phone, session, admin }) => {
  const pick = pickIndex(input, RELATIONSHIPS.length)
  if (pick === null) return sendText(phone, 'Please select one of the relationships above.')
  await patchNote(admin, session, { depRelationship: RELATIONSHIPS[pick] })
  const products = await getActiveProducts(admin)
  await sendText(phone, `Select the dependant's cover\n\n${products.map((p, i) => `${i + 1}. ${p.name} [$${p.premium}/month]`).join('\n')}`)
  return setState(admin, session, 'AD_PRODUCT')
}

const adProduct: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const products = await getActiveProducts(admin)
  const pick = pickIndex(input, products.length)
  if (pick === null) return sendText(phone, 'Please select one of the products above.')
  const p = products[pick]
  const n = session.note
  await patchNote(admin, session, { depProductId: p.id })
  // Health-category dependant cover takes the dependant's own medical
  // declaration — the holder's declaration says nothing about them.
  if (p.category === 'health') {
    await sendButtons(phone,
      `Medical declaration — ${p.name}\n\nDoes ${n.depName} have a chronic illness or existing condition?`,
      [{ id: 'no', title: 'No' }, { id: 'yes', title: 'Yes' }])
    return setState(admin, session, 'AD_CHRONIC')
  }
  return commitDependantPick(ctx, p)
}

/** Health dependant declarations land in the same dependant object the
 *  portal renders — the record is identical whoever captured it. */
const adChronic: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  if (input !== 'yes' && input !== 'no') return sendText(phone, 'Please choose one of the buttons above.')
  if (input === 'yes') {
    await sendText(phone, `Please state ${session.note.depName}'s chronic condition or treatment.`)
    return setState(admin, session, 'AD_CHRONIC_DETAILS')
  }
  await patchNote(admin, session, { depChronic: 'no' })
  const p = (await getActiveProducts(admin)).find(x => x.id === session.note.depProductId)
  if (!p) { await deleteSession(admin, session); return sendText(phone, 'That cover is no longer available — your session has been reset.') }
  return commitDependantPick(ctx, p)
}

const adChronicDetails: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const d = input.trim()
  if (d.length < 4 || d.length > 300) return sendText(phone, 'Please state the chronic condition or treatment briefly.')
  await patchNote(admin, session, { depChronic: 'yes', depChronicDetails: d })
  const p = (await getActiveProducts(admin)).find(x => x.id === session.note.depProductId)
  if (!p) { await deleteSession(admin, session); return sendText(phone, 'That cover is no longer available — your session has been reset.') }
  return commitDependantPick(ctx, p)
}

async function commitDependantPick(ctx: Ctx, p: BotProduct) {
  const { phone, session, admin } = ctx
  const n = session.note
  await patchNote(admin, session, {
    flow: 'new_dependant',
    dependant: {
      name: n.depName, nationalId: n.depNationalId, dob: n.depDob, gender: n.depGender,
      relationship: n.depRelationship, productId: p.id, productName: p.name,
      premium: p.premium, coverAmount: p.coverAmount,
      ...(n.depChronic === 'yes' ? { hasChronicIllness: true, chronicIllnessDetails: n.depChronicDetails } : {}),
    },
    payLabel: `Dependant — ${n.depName} on ${n.depPolicyNumber} (${p.name})`,
  })
  return startTail(ctx, 'AD', p.premium)
}

/* --------------------------- 3. My Clients -------------------------------- */

const viewClients: Handler = async ({ phone, admin, contact }) => {
  const clients = await clientsOfAgent(admin, contact.agent!.id)
  return sendText(phone, clients.length
    ? `You have ${clients.length} client${clients.length === 1 ? '' : 's'}\n\n${clients.map((c, i) => `(${i + 1}) ${c.name}\nID: ${c.nationalId}\nContact: ${c.phone}`).join('\n\n')}`
    : 'You have no clients yet — option 1 adds one.')
}

/* --------------------------- 4. Commission -------------------------------- */

/** Real commission — premium x product.commission_pct across every live
 *  policy on the agent's book, same field the portal's reports read. */
const commission: Handler = async ({ phone, admin, contact }) => {
  const { rows, total } = await commissionForAgent(admin, contact.agent!.id)
  return sendText(phone, rows.length
    ? `Your commission book (per month)\n\n${rows.join('\n')}\n\nTotal: $${total.toFixed(2)}/month`
    : 'No live policies on your book yet — commission shows here once your clients are covered.')
}

/* --------------------------- 5. Make Payment ------------------------------ */

const apayId: Handler = async ({ input, phone, session, admin }) => {
  if (!isNationalId(input)) return sendText(phone, 'Please enter a valid national ID (e.g. 632118532K12).')
  const client = await clientByNationalId(admin, input)
  if (!client) return sendText(phone, 'No client with that national ID exists (send exit to cancel).')
  await patchNote(admin, session, { payClientId: client.id, payClientName: client.name })
  const policies = await policiesForClient(admin, client.id)
  if (!policies.length) {
    await deleteSession(admin, session)
    return sendText(phone, `${client.name} has no policies to pay for.`)
  }
  await sendText(phone, `Select ${client.name}'s policy\n\n${policies.map((p, i) => `${i + 1}. ${p.policyNumber} — ${p.productName} ($${p.premium}/month, ${p.status})`).join('\n')}`)
  return setState(admin, session, 'APAY_POLICY')
}

const apayPolicy: Handler = async ({ input, phone, session, admin }) => {
  const policies = await policiesForClient(admin, String(session.note.payClientId))
  const pick = pickIndex(input, policies.length)
  if (pick === null) return sendText(phone, 'Please select one of the policies above.')
  const p = policies[pick]
  await patchNote(admin, session, { flow: 'pay_policy', payPolicyId: p.id, payPolicyNumber: p.policyNumber, policyPremium: p.premium })
  await sendText(phone, `How many months of ${p.policyNumber}? (1–12)`)
  return setState(admin, session, 'APAY_MONTHS')
}

const apayMonths: Handler = async (ctx) => {
  const { input, phone, session, admin } = ctx
  const months = Number(input.trim())
  if (!Number.isInteger(months) || months < 1 || months > 12) return sendText(phone, 'Please enter a number between 1 and 12.')
  await patchNote(admin, session, {
    months,
    payLabel: `${session.note.payPolicyNumber} (${session.note.payClientName}) x ${months} month${months === 1 ? '' : 's'}`,
  })
  return startTail(ctx, 'APAY', Number(session.note.policyPremium ?? 0) * months)
}

export const AGENT_HANDLERS: Record<string, Handler> = {
  AGENT_MENU: menu,
  AC_NAME: acName, AC_ID: acId, AC_GENDER: acGender, AC_GENDER_OTHER: acGenderOther,
  AC_DOB: acDob, AC_EMAIL: acEmail, AC_PHONE: acPhone, AC_PRODUCT: acProduct,
  AC_CHRONIC: acChronic, AC_CHRONIC_DETAILS: acChronicDetails,
  ...makeTail('AC'),
  AD_HOLDER_ID: adHolderId, AD_POLICY: adPolicy, AD_NAME: adName, AD_ID: adId,
  AD_GENDER: adGender, AD_GENDER_OTHER: adGenderOther, AD_DOB: adDob,
  AD_REL: adRel, AD_PRODUCT: adProduct,
  AD_CHRONIC: adChronic, AD_CHRONIC_DETAILS: adChronicDetails,
  ...makeTail('AD'),
  APAY_ID: apayId, APAY_POLICY: apayPolicy, APAY_MONTHS: apayMonths,
  ...makeTail('APAY'),
}
