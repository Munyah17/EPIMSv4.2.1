import type { Handler } from '../types.js'
import { sendText, sendButtons } from '../whatsapp.js'
import { setState, patchNote, deleteSession } from '../store.js'
import { getActiveProducts, createClient, createPolicy } from '../data.js'
import { isFullName, isNationalId, isEmail, parseDob, isEcocashPhone, pickIndex, PAYMENT_METHODS, methodMenu, sendPaymentInstruction, datePlusOneYear } from '../helpers.js'

/**
 * New-client registration — the Frappe CLIENT_REG_HANDLER_MAP.
 *
 *   menu -> full name -> national ID -> gender (male/female/other text)
 *   -> DOB -> email (or 1 to skip)
 *   -> product -> payment currency -> payment method
 *   -> [EcoCash number] -> confirm -> client + pending policy created
 *   -> payment instruction -> portal pointer -> session done.
 *
 * One deliberate difference from the Frappe flow, documented in
 * docs/whatsapp-bot.md: the caller's own WhatsApp number IS the
 * contact number, so it is never asked. Gender is a real column
 * (clients.gender) and 'Other' stores the text the client types.
 */

const MENU_TEXT = (u: string) =>
  `Welcome to Motions Insurance${u ? `, ${u}` : ''}! Select an option\n\n` +
  `1. Register for a policy\n2. View available products\n3. Payment methods\n\n` +
  `Type 'exit' at any point to restart.`

const menu: Handler = async ({ input, phone, username, session, admin }) => {
  if (input === '1') {
    await sendText(phone, 'Enter your full name (e.g. Joe Marowa)')
    return setState(admin, session, 'REG_NAME')
  }
  if (input === '2') {
    const products = await getActiveProducts(admin)
    await sendText(phone, products.length
      ? `Available products\n\n${products.map((p, i) => `${i + 1}. ${p.name} — $${p.premium}/month, cover $${p.coverAmount}`).join('\n')}\n\nSend 1 to register.`
      : 'No products are available right now. Please try again later.')
    return
  }
  if (input === '3') {
    await sendText(phone, `Payment methods\n\nUSD:\n${methodMenu('usd')}\n\nZiG:\n${methodMenu('zig')}\n\nSend 1 to register.`)
    return
  }
  await sendText(phone, MENU_TEXT(username))
}

const name_: Handler = async ({ input, phone, session, admin }) => {
  if (!isFullName(input)) return sendText(phone, 'Please enter a valid full name.')
  await patchNote(admin, session, { name: input.trim() })
  await sendText(phone, 'Enter your national ID (e.g. 083837373U23)')
  return setState(admin, session, 'REG_ID')
}

const id: Handler = async ({ input, phone, session, admin }) => {
  if (!isNationalId(input)) return sendText(phone, 'Please enter a valid national ID.')
  await patchNote(admin, session, { nationalId: input.trim() })
  await sendButtons(phone, 'Select your gender', [
    { id: 'male', title: 'Male' }, { id: 'female', title: 'Female' }, { id: 'other', title: 'Other' },
  ])
  return setState(admin, session, 'REG_GENDER')
}

const gender: Handler = async ({ input, phone, session, admin }) => {
  if (input === 'other') {
    await sendText(phone, 'Type your preferred gender (e.g. non-binary)')
    return setState(admin, session, 'REG_GENDER_OTHER')
  }
  if (input !== 'male' && input !== 'female') return sendText(phone, 'Please choose one of the buttons above.')
  await patchNote(admin, session, { gender: input })
  await sendText(phone, 'Enter your date of birth (e.g. 26-05-1990)')
  return setState(admin, session, 'REG_DOB')
}

const genderOther: Handler = async ({ input, phone, session, admin }) => {
  const g = input.trim()
  if (g.length < 2 || g.length > 40) return sendText(phone, 'Please type your preferred gender.')
  await patchNote(admin, session, { gender: g })
  await sendText(phone, 'Enter your date of birth (e.g. 26-05-1990)')
  return setState(admin, session, 'REG_DOB')
}

const dob: Handler = async ({ input, phone, session, admin }) => {
  const iso = parseDob(input)
  if (!iso) return sendText(phone, 'Please enter a valid date in DD-MM-YYYY format.')
  await patchNote(admin, session, { dob: iso })
  await sendText(phone, 'Enter your email address, or 1 to skip')
  return setState(admin, session, 'REG_EMAIL')
}

const email: Handler = async ({ input, phone, session, admin }) => {
  if (input.trim() !== '1') {
    if (!isEmail(input)) return sendText(phone, 'Please enter a valid email address, or 1 to skip.')
    await patchNote(admin, session, { email: input.trim() })
  }
  const products = await getActiveProducts(admin)
  if (!products.length) {
    await sendText(phone, 'No products are available right now. Please try again later.')
    return deleteSession(admin, session)
  }
  await sendText(phone,
    `Select a product\n\nTerms & conditions: https://portal.motions.co.zw\n\n` +
    products.map((p, i) => `${i + 1}. ${p.name} [$${p.premium}/month — cover $${p.coverAmount}]`).join('\n'))
  return setState(admin, session, 'REG_PRODUCT')
}

const product: Handler = async ({ input, phone, session, admin }) => {
  const products = await getActiveProducts(admin)
  const pick = pickIndex(input, products.length)
  if (pick === null) return sendText(phone, 'Please select one of the products above.')
  await patchNote(admin, session, { productId: products[pick].id })
  await sendButtons(phone, 'Select payment currency', [
    { id: 'USD', title: 'USD' }, { id: 'ZiG', title: 'ZiG' },
  ])
  return setState(admin, session, 'REG_CURRENCY')
}

const currency: Handler = async ({ input, phone, session, admin }) => {
  if (input !== 'USD' && input !== 'ZiG') return sendText(phone, 'Please select one of the currencies above.')
  const key = input.toLowerCase()
  await patchNote(admin, session, { currency: input })
  await sendText(phone, `Select payment method\n\n${methodMenu(key)}`)
  return setState(admin, session, 'REG_METHOD')
}

const method: Handler = async ({ input, phone, session, admin }) => {
  const key = String(session.note.currency ?? 'USD').toLowerCase()
  const pick = pickIndex(input, PAYMENT_METHODS[key].length)
  if (pick === null) return sendText(phone, 'Please select one of the payment methods above.')
  await patchNote(admin, session, { methodIndex: pick, method: PAYMENT_METHODS[key][pick] })
  if (pick === 0) {
    await sendText(phone, 'Enter the EcoCash number to charge, in format 077XXXXXXXX or 2637XXXXXXXX')
    return setState(admin, session, 'REG_ECOCASH')
  }
  await confirmPrompt(admin, session, phone)
  return setState(admin, session, 'REG_CONFIRM')
}

const ecocash: Handler = async ({ input, phone, session, admin }) => {
  if (!isEcocashPhone(input)) return sendText(phone, 'Please enter a valid EcoCash number (077XXXXXXXX or 2637XXXXXXXX).')
  await patchNote(admin, session, { ecocashNumber: input.trim() })
  await confirmPrompt(admin, session, phone)
  return setState(admin, session, 'REG_CONFIRM')
}

const confirm: Handler = async ({ input, phone, session, admin, username }) => {
  if (input !== 'pay' && input !== 'cancel') return sendText(phone, 'Please choose one of the buttons above.')
  if (input === 'cancel') {
    await deleteSession(admin, session)
    return sendText(phone, 'Registration cancelled.')
  }

  const n = session.note
  const product = (await getActiveProducts(admin)).find(p => p.id === n.productId)
  if (!product) {
    await deleteSession(admin, session)
    return sendText(phone, 'That product is no longer available. Your session has been reset — send any message to start again.')
  }

  const client = await createClient(admin, {
    name: String(n.name), nationalId: String(n.nationalId), phone,
    email: n.email as string | undefined, dob: n.dob as string | undefined,
    gender: n.gender as string | undefined,
  })
  const { start, end } = datePlusOneYear()
  const policy = await createPolicy(admin, {
    clientId: client.id, product, paymentMethod: String(n.method ?? ''),
    startDate: start, endDate: end,
  })

  await sendPaymentInstruction({
    admin, phone, policyId: policy.id, reference: `${policy.policyNumber}`,
    usdAmount: policy.premium, currency: (n.currency as 'USD' | 'ZiG') ?? 'USD',
    methodIndex: Number(n.methodIndex ?? 1), ecocashNumber: n.ecocashNumber as string | undefined,
    origin: 'https://portal.motions.co.zw', description: `${policy.policyNumber} premium`,
  })
  await sendText(phone,
    `Registration complete — policy ${policy.policyNumber} (${product.name}) is pending first payment.\n\n` +
    `You can also manage your cover on the portal: https://portal.motions.co.zw — sign up with this phone number and your national ID.`)
  return deleteSession(admin, session)
}

async function confirmPrompt(admin: Parameters<Handler>[0]['admin'], session: Parameters<Handler>[0]['session'], phone: string) {
  const n = session.note
  const products = await getActiveProducts(admin)
  const p = products.find(x => x.id === n.productId)
  await sendButtons(phone,
    `Confirm your registration\n\n` +
    `Name: ${n.name}\nNational ID: ${n.nationalId}\n` +
    `Product: ${p?.name ?? ''} ($${p?.premium}/month)\n` +
    `Payment: ${n.method ?? ''}${n.ecocashNumber ? ` (${n.ecocashNumber})` : ''}`,
    [{ id: 'pay', title: 'Register & Pay' }, { id: 'cancel', title: 'Cancel' }])
}

export const REG_HANDLERS: Record<string, Handler> = {
  REG_MENU: menu,
  REG_NAME: name_,
  REG_ID: id,
  REG_GENDER: gender,
  REG_GENDER_OTHER: genderOther,
  REG_DOB: dob,
  REG_EMAIL: email,
  REG_PRODUCT: product,
  REG_CURRENCY: currency,
  REG_METHOD: method,
  REG_ECOCASH: ecocash,
  REG_CONFIRM: confirm,
}
