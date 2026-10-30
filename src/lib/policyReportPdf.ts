import type { jsPDF } from 'jspdf'
import type { Policy, Client } from '../types'
import { formatDate } from './dateUtils.js'
import { policyBillablePremium, billableHeadCount } from './premium.js'
import { holderMemberNumber, dependantMemberNumber } from './memberNumbers.js'
import { termsPagesFor } from './policyTerms.js'
import { policySourceLabel } from './policySources.js'
import { COMPANY_NAME } from './company.js'
import { isTobaccoFieldToFloor, fieldToFloorCover } from './smsText.js'

/**
 * The policy report/certificate PDF builder, split out of exportUtils.ts
 * so api/ serverless functions can use it: exportUtils pulls in
 * mailService/storage/geocode (localStorage + the browser supabase
 * client), which cannot run under Node. Everything this module touches
 * is pure — the letterhead's company contact block is PASSED IN rather
 * than read from localStorage so both sides share one document.
 *
 * `cfg` is the letterhead's Head Office block: the browser hands in
 * getNotifSettings(); api/ callers pass the app_settings 'notif_settings'
 * row's value (same fields). Missing fields are simply not printed.
 *
 * Every relative import here carries .js — api/ functions run as
 * transpiled ESM where Node resolves literally.
 */
export interface LetterheadContact {
  companyAddress?: string
  companyPhone?: string
  companyEmail?: string
}

const AGRICULTURE_COVER = ['Barn Fire', 'Hail Storm', 'Wind Storm']
/** Standard excess applied unless a product has its own excess configured. */
const DEFAULT_POLICY_EXCESS = '15% of loss'

/**
 * Tobacco "Field to Floor" cover runs with the tobacco season, not the day
 * the policy was keyed in — the document always shows the season dates.
 * Perils are itemised per sum insured: a $2,000 policy shows $500 per
 * peril (four × $500), a $1,000 policy shows $250 on the field perils but
 * the funeral benefit stays $500 — it is the grower's funeral cover, not
 * scaled with the crop.
 */
const TOBACCO_SEASON = { start: '15-NOV-2026', end: '31-AUG-2027' }

/** Money on a printed policy document always carries thousands separators
 *  and exactly two decimals -- "$12,000.00", never "$12000". */
function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const BRAND_BLUE: [number, number, number] = [65, 105, 225]
export const BRAND_RED: [number, number, number] = [200, 30, 40]
export const MUTED: [number, number, number] = [107, 126, 153]
export const TEXT: [number, number, number] = [15, 28, 46]
export const NAVY: [number, number, number] = [33, 46, 108]
export const TABLE_HEAD: [number, number, number] = [191, 200, 232]

/** Shared masthead for official client-facing documents: logo top-left,
 *  Head Office contact block right-aligned. Only
 *  prints what's actually configured (Settings -> Notifications -> Company
 *  Details); a wrong address on an official document is worse than an
 *  absent one. */
/** Draws the masthead and returns the y where body text can start.
 *  Callers used to hard-code y = 26 or 32, which lands the title on top
 *  of the Head Office phone block (three lines plus email). */
export function drawLetterhead(doc: jsPDF, pageWidth: number, logo: string | null, brandName: string, cfg: LetterheadContact): number {
  const logoBottom = logo ? 28 : 22
  if (logo) {
    doc.addImage(logo, 'PNG', 14, 8, 20, 20)
  } else {
    doc.setFontSize(12)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...NAVY)
    doc.text(brandName, 14, 20)
    doc.setFont('helvetica', 'normal')
  }
  let ry = 11
  if (cfg.companyAddress || cfg.companyPhone || cfg.companyEmail) {
    doc.setFontSize(8)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...TEXT)
    doc.text('Head Office:', pageWidth - 14, ry, { align: 'right' })
    doc.setFont('helvetica', 'normal')
    ry += 4
  }
  if (cfg.companyAddress) {
    const addrLines = doc.splitTextToSize(cfg.companyAddress, 78)
    addrLines.forEach((line: string) => { doc.text(line, pageWidth - 14, ry, { align: 'right' }); ry += 4 })
  }
  if (cfg.companyPhone) {
    // One number per line rather than width-wrapping the joined string --
    // a wrap can land mid-number ("+263 780 / 086 175"), which looks
    // broken on an official document.
    cfg.companyPhone.split('/').map(p => p.trim()).filter(Boolean).forEach((number, i) => {
      doc.text(i === 0 ? `Phone: ${number}` : number, pageWidth - 14, ry, { align: 'right' })
      ry += 4
    })
  }
  if (cfg.companyEmail) {
    doc.text(`Email: ${cfg.companyEmail}`, pageWidth - 14, ry, { align: 'right' })
    ry += 4
  }
  return Math.max(logoBottom, ry) + 4
}
/**
 * The terms document is part of the contract: the policy's own product
 * Terms and Conditions — and ONLY its own (a funeral policy carries
 * funeral terms; a tobacco policy carries tobacco + its funeral rider —
 * there is no shared General Conditions section). It flows on from the
 * schedule above in two newspaper-style columns: the first terms page's
 * columns begin below whatever already printed, later pages run edge to
 * edge. The point is brevity — a policy document is two pages at most, not a booklet.
 * For tobacco insurance, allow up to 2.5 pages.
 */
export function drawTermsPages(doc: jsPDF, product: { name?: string; category?: string }, startY: number) {
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const MARGIN = 14
  const GAP = 8
  const colW = (pageWidth - MARGIN * 2 - GAP) / 2
  const xOf = (c: number) => MARGIN + c * (colW + GAP)
  const bottom = pageHeight - 12
  const PAGE_TOP = 12

  let col = 0
  let y = startY
  let colTop = startY

  // Points to millimetres, with the font that will actually be drawn.
  // Wrapping at a smaller font and then drawing bold made headings run
  // across the gutter into the other column.
  const leadMm = () => (doc.getFontSize() * doc.getLineHeightFactor() * 25.4) / 72
  const ensure = (need: number) => {
    if (y + need <= bottom) return
    if (col === 0) {
      col = 1
      y = colTop
      if (y + need <= bottom) return
    }
    doc.addPage()
    col = 0
    y = PAGE_TOP
    colTop = PAGE_TOP
  }
  const drawLines = (lines: string[], x: number) => {
    const lead = leadMm()
    ensure(lines.length * lead + 1)
    for (const line of lines) {
      doc.text(line, x, y)
      y += lead
    }
  }
  const heading = (text: string) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(...NAVY)
    const lines = doc.splitTextToSize(text, colW)
    drawLines(lines, xOf(col))
    y += 0.6
  }
  const para = (text: string) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...TEXT)
    const lines = doc.splitTextToSize(text, colW - 1)
    drawLines(lines, xOf(col))
    y += 1
  }

  heading('TERMS AND CONDITIONS')
  y += 0.3
  const allTerms = termsPagesFor(product)
  for (let i = 0; i < allTerms.length; i++) {
    const terms = allTerms[i]
    // Add product title heading when there are multiple terms (e.g., tobacco + funeral)
    if (allTerms.length > 1 && terms.productTitle) {
      ensure(4)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(7.5)
      doc.setTextColor(...BRAND_RED)
      doc.text(terms.productTitle.toUpperCase(), xOf(col), y)
      // A full line's lead — 1.5mm put the following 'Preamble' heading on
      // top of the product title.
      y += 4
      doc.setTextColor(...TEXT)
    }
    if (terms.sections) {
      for (const section of terms.sections) {
        heading(section.heading)
        section.paragraphs.forEach(para)
        y += 0.5
      }
    } else {
      heading(terms.exclusionsHeading)
      para(terms.exclusionsIntro)
      terms.exclusions.forEach((e, idx) => para(`${idx + 1}. ${e}`))
      y += 0.5
    }
    // Add separator between multiple terms sections
    if (i < allTerms.length - 1) {
      ensure(3)
      doc.setDrawColor(220, 226, 240)
      doc.line(xOf(col), y, xOf(col) + colW, y)
      y += 1.5
    }
  }

  // Execution block — every issued policy document ends with the signee's
  // full name, date of signature and signature fields.
  heading('SIGNATURE')
  para('I confirm that I have read, understood and agree to the Policy Terms and Conditions and the Major Exclusions set out in this document.')
  ensure(16)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  doc.setTextColor(...TEXT)
  doc.text('Signee Full Name: __________________________', xOf(col) + 1.5, y)
  y += 5
  doc.text('Date of Signature: ____________________', xOf(col) + 1.5, y)
  y += 5
  doc.text('Signature: ______________________________', xOf(col) + 1.5, y)
  y += 5
}

/** Builds the policy report/certificate PDF, laid out to match the Motions
 *  Microinsurance policy document template: a plain (non-banded) header
 *  with the logo on the left and company contact details on the right,
 *  a payment summary strip, then banded POLICY INFORMATION / PERSONAL
 *  INFORMATION / DEPENDANTS sections — each dependant gets its own boxed
 *  sub-table since they can each carry their own plan. Returns the jsPDF
 *  doc so callers can either save it to disk or pull it out as a base64
 *  attachment for email. Not offered for funeral packages — funeral
 *  policies use a different document elsewhere in the flow. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildPolicyReportDoc(policy: Policy, client: Client, category: string, cfg: LetterheadContact): Promise<any> {
  const [{ jsPDF }, { default: autoTable }, { MOTIONS_LOGO_PNG_BASE64 }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), import('../assets/motionsLogo.js'),
  ])
  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()

  const ensureRoom = (need: number) => {
    if (y + need > pageHeight - 2) { doc.addPage(); y = 4 }
  }

  let y = drawLetterhead(doc, pageWidth, MOTIONS_LOGO_PNG_BASE64, COMPANY_NAME, cfg)
  doc.setFontSize(9)
  doc.setTextColor(...TEXT)
  // Agriculture policyholders are identified by name AND grower number
  // together ("Harold Muwi - 2344566") -- it's their identity to the
  // insurer, so it belongs beside the name, not in a section of its own.
  // Agriculture is billed once a year (Stop Order), never monthly -- the
  // whole reason it's handled separately from every other category.
  const isAgriculture = category === 'agriculture'
  // Field-to-Floor is bound to the tobacco season, not the capture date —
  // the document prints the fixed season window regardless.
  const isFieldToFloor = isAgriculture && isTobaccoFieldToFloor(policy.productName)
  const premiumHeading = isAgriculture ? 'Annual Premium' : 'Monthly Premium'
  // Agriculture documents run shorter than page 1 — wider gaps spread the
  // sections so the sheet reads full instead of ending two-thirds down.
  const sectionGap = isAgriculture ? 5 : 4
  // "Harold Muwi - 2344566 · Contractor: AgriCo" — the grower's identity
  // to the insurer is name + grower number + who holds their contract.
  // Captured data prints in capitals regardless of the case the capturer
  // used — a formal document reads the same for every policyholder.
  // (Body text — conditions, the terms pages — stays in normal case.)
  const up = (s?: string | null) => (s ?? '').toUpperCase()
  // Identity block — each detail on its own line with better spacing
  doc.setFont('helvetica', 'bold')
  doc.text(up(client.name), 14, y)
  y += 4
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  if (isAgriculture && policy.growerNumber) { doc.text(`Grower No: ${up(policy.growerNumber)}`, 14, y); y += 3 }
  if (isAgriculture && policy.contractor) { doc.text(`Contractor: ${up(policy.contractor)}`, 14, y); y += 3 }
  if (isAgriculture && policy.hectarage != null) { doc.text(`Hectarage: ${policy.hectarage} ha`, 14, y); y += 3 }
  // The agent who wrote the business belongs on the document — it's the
  // person the policyholder claims to, not an internal note.
  // The agent/field officer who sourced the business belongs on the
  // document; the staff member who captured it is internal attribution —
  // view modal and records only, not the client's copy.
  // Field Officer is only shown for Tobacco Insurance (Small Scale Agriculture)
  if (isFieldToFloor && policy.agentName) { doc.text(`Field Officer: ${up(policy.agentName)}`, 14, y); y += 3 }
  y += 1
  doc.setTextColor(...TEXT)
  y += 3

  // Premiums are per head everywhere except agriculture, so the figure on
  // an official document is the whole policy's — the policyholder plus
  // every dependant — not the policyholder's own share.
  const billedPremium = policyBillablePremium(policy, category)
  const heads = billableHeadCount(policy, category)

  autoTable(doc, {
    startY: y,
    head: [['Amount Paid', 'Payment Method', isAgriculture ? 'Commencement Date' : 'Payment Date', 'Expiration Date']],
    body: [[money(billedPremium), up(policy.paymentMethod), isAgriculture ? TOBACCO_SEASON.start : formatDate(policy.nextPaymentDate), isFieldToFloor ? TOBACCO_SEASON.end : formatDate(policy.endDate)]],
    styles: { fontSize: 9, lineColor: [220, 226, 240], lineWidth: 0.3, cellPadding: 2 },
    headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold', fontSize: 9.5 },
    theme: 'grid',
    margin: { left: 14, right: 14 },
  })
  y = (doc as any).lastAutoTable.finalY + sectionGap

  const sectionBand = (title: string) => {
    ensureRoom(7)
    doc.setFillColor(...NAVY)
    doc.rect(14, y, pageWidth - 28, 5, 'F')
    doc.setFontSize(9)
    doc.setTextColor(255, 255, 255)
    doc.text(title, 14 + (pageWidth - 28) / 2, y + 3.5, { align: 'center' })
    doc.setTextColor(...TEXT)
    // Content under a band is drawn by baseline — 9pt glyphs reach ~2.4mm
    // above their baseline, so anything closer than ~9mm to the band top
    // climbs back inside the band. 9.5 keeps the first line clearly below.
    y += 9.5
  }

  // Seven columns on A4 crushed the member number and "Currency" onto
  // the cell borders, so the same facts print as two readable rows.
  const grid = {
    styles: { fontSize: 8, overflow: 'linebreak' as const, lineColor: [220, 226, 240] as [number, number, number], lineWidth: 0.3, cellPadding: 1.8 },
    headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold' as const, fontSize: 8 },
    theme: 'grid' as const,
    margin: { left: 14, right: 14 },
  }
  sectionBand('POLICY INFORMATION')
  autoTable(doc, {
    startY: y,
    head: [['Member No.', 'Policy Package', 'Status']],
    body: [[
      holderMemberNumber(policy.policyNumber), up(policy.productName),
      policy.status.replace(/_/g, ' ').toUpperCase(),
    ]],
    ...grid,
  })
  y = (doc as any).lastAutoTable.finalY + 2
  autoTable(doc, {
    startY: y,
    head: [[premiumHeading, 'Cover', 'Currency', 'Issued Via']],
    body: [[money(policy.premium), money(policy.coverAmount), 'USD', policySourceLabel(policy.source)]],
    ...grid,
  })
  y = (doc as any).lastAutoTable.finalY + sectionGap

  sectionBand('PERSONAL INFORMATION')
  autoTable(doc, {
    startY: y,
    head: [['Full Name', 'National ID', 'Mobile Number', 'Date of Birth', 'Registration Date']],
    body: [[up(client.name), up(client.nationalId), client.phone, formatDate(client.dob), formatDate(client.createdAt)]],
    ...grid,
  })
  y = (doc as any).lastAutoTable.finalY + sectionGap

  // Organisation policies name the insured organisation — and, for team
  // cover, the activity/season the roster is insured for. PERSONAL
  // INFORMATION above still shows the account-holder contact, not the
  // insured party.
  if (policy.groupName) {
    sectionBand(policy.coverScope === 'corporate' ? 'ORGANISATION' : policy.coverScope === 'team' ? 'TEAM' : 'GROUP')
    autoTable(doc, {
      startY: y,
      head: [[policy.coverScope === 'corporate' ? 'Company' : 'Organisation', ...(policy.coverScope === 'team' ? ['Activity / Season'] : []), 'Cover Type']],
      body: [[
        up(policy.groupName),
        ...(policy.coverScope === 'team' ? [up(policy.teamActivity) || '—'] : []),
        policy.coverScope === 'corporate' ? 'Corporate — employees covered' : policy.coverScope === 'team' ? 'Team — activity cover, immediate' : 'Group — members covered',
      ]],
      styles: { fontSize: 9, lineColor: [220, 226, 240], lineWidth: 0.3, cellPadding: 2 },
      headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold', fontSize: 9.5 },
      theme: 'grid',
      margin: { left: 14, right: 14 },
    })
    y = (doc as any).lastAutoTable.finalY + sectionGap
  }

  // The covered-people band wears the scope's vocabulary: a corporate
  // policy covers employees, a group policy covers members, an individual
  // policy covers dependants. Roster members ride in the same dependants
  // array, so the per-person sub-tables below need no other changes —
  // their RELATIONSHIP already reads 'Employee'/'Member'.
  const coveredBand = policy.coverScope === 'corporate' ? 'EMPLOYEES COVERED'
    : policy.coverScope === 'team' ? 'TEAM ROSTER COVERED'
    : policy.coverScope === 'group' ? 'MEMBERS COVERED'
    : 'DEPENDANTS'
  sectionBand(coveredBand)
  if (policy.dependants.length === 0) {
    doc.setFontSize(10)
    doc.setTextColor(...MUTED)
    doc.text(
      policy.coverScope === 'corporate' ? 'No employees on this policy.'
        : policy.coverScope === 'team' || policy.coverScope === 'group' ? 'No members on this policy.'
        : 'No dependants on this policy.',
      14, y,
    )
    doc.setTextColor(...TEXT)
    y += 3
  } else {
    policy.dependants.forEach((d, i) => {
      ensureRoom(32)
      doc.setFontSize(8)
      doc.setTextColor(...NAVY)
      const header = doc.splitTextToSize(
        `MEMBER NO: ${dependantMemberNumber(policy.policyNumber, i)}  |  FULL NAME: ${up(d.name)}  |  NATIONAL ID: ${up(d.nationalId) || '—'}  |  RELATIONSHIP: ${up(d.relationship)}  |  DATE OF BIRTH: ${formatDate(d.dob)}`,
        pageWidth - 32,
      )
      // Draw each line ourselves. Passing the array to doc.text() uses a
      // leading that does not match a hand-rolled y step, so the table
      // below was climbing back over the last line.
      const headerLead = (doc.getFontSize() * doc.getLineHeightFactor() * 25.4) / 72
      for (const line of header) {
        doc.text(line, 18, y)
        y += headerLead
      }
      doc.setTextColor(...TEXT)
      y += 2
      autoTable(doc, {
        startY: y,
        head: [['Policy Package', premiumHeading, 'Cover', 'Currency', 'Status']],
        body: [[
          up(d.productName ?? policy.productName),
          money(d.premium ?? policy.premium),
          money(d.coverAmount ?? policy.coverAmount), 'USD', policy.status.toUpperCase(),
        ]],
        styles: { fontSize: 9, lineColor: [220, 226, 240], lineWidth: 0.3, cellPadding: 2 },
        headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold', fontSize: 9.5 },
        theme: 'grid',
        margin: { left: 14, right: 14 },
      })
      y = (doc as any).lastAutoTable.finalY + sectionGap
    })

    // Everyone on the policy is charged, so the document says what the
    // policy actually costs rather than leaving the client to add it up.
    if (heads > 1) {
      ensureRoom(12)
      doc.setFontSize(8.5)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...TEXT)
      doc.text(
        `TOTAL ${premiumHeading.toUpperCase()} (${heads} MEMBERS): ${money(billedPremium)}`,
        pageWidth - 14, y, { align: 'right' },
      )
      doc.setFont('helvetica', 'normal')
      y += 1.5
    }
  }

  if (isAgriculture) {
    if (isFieldToFloor) {
      // Field to Floor itemises each peril with its benefit amount —
      // the figure is set by the product tier (Entry/Basic $250,
      // Standard $500, Comfort $750, Premium $1,000) except Funeral,
      // which is a flat $500 grower benefit at every tier.
      const cover = fieldToFloorCover(policy.productName, policy.premium)
      ensureRoom(22 + cover.length * 7)
      sectionBand('COVER PROVIDED (FIELD TO FLOOR)')
      autoTable(doc, {
        startY: y,
        head: [['Cover', 'Benefit']],
        body: cover.map(c => [c.peril, money(c.benefit)]),
        styles: { fontSize: 9, lineColor: [220, 226, 240], lineWidth: 0.3, cellPadding: 2 },
        headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold', fontSize: 9.5 },
        columnStyles: { 1: { halign: 'right' } },
        theme: 'grid',
        margin: { left: 14, right: 14 },
      })
      y = (doc as any).lastAutoTable.finalY + sectionGap
    } else {
      ensureRoom(20 + AGRICULTURE_COVER.length * 5)
      sectionBand('COVER PROVIDED')
      doc.setFillColor(...BRAND_RED)
      doc.setFontSize(9)
      AGRICULTURE_COVER.forEach((peril, i) => {
        doc.circle(15.5, y + i * 5 - 1.3, 0.9, 'F')
        doc.text(peril, 19, y + i * 5)
      })
      y += AGRICULTURE_COVER.length * 5 + 2
    }
  }

  // Excess belongs to agriculture cover and nothing else. Printing it on a
  // funeral or medical document -- and defaulting it to agriculture's 15%
  // when the product has none configured -- told those policyholders they
  // carry a deductible their policy does not have.
  if (isAgriculture) {
    const excessLines = doc.splitTextToSize(policy.excess || DEFAULT_POLICY_EXCESS, pageWidth - 32)
    ensureRoom(14 + excessLines.length * 5)
    sectionBand('POLICY EXCESS')
    doc.setFontSize(9)
    doc.setTextColor(...TEXT)
    doc.text(excessLines, 14, y)
    y += excessLines.length * 3
  }

  // ── POLICY CONDITIONS — the plain-language summary the client reads
  // first. It is a breakdown, not a contract — the exclusion schedules
  // appended at the end always govern. This section goes on page 1.
  const conditions: string[] = []
  if (isFieldToFloor) {
    conditions.push('This policy covers the policyholder and one spouse only for the funeral benefit.')
    if (policy.hectarage != null) conditions.push(`Cover applies to the insured ${policy.hectarage} ha of crop only — any planted area beyond it is not covered.`)
    conditions.push(`Cover runs with the tobacco season (${TOBACCO_SEASON.start} to ${TOBACCO_SEASON.end}), not the date this document was issued.`)
    conditions.push('Each peril pays up to its scheduled benefit above — no claim exceeds its own peril\'s cover.')
  } else if (isAgriculture) {
    conditions.push('Cover applies only to the insured crop and the perils listed above.')
    if (policy.hectarage != null) conditions.push(`Cover applies to the insured ${policy.hectarage} ha of crop only — any planted area beyond it is not covered.`)
    conditions.push(`Cover runs with the tobacco season (${TOBACCO_SEASON.start} to ${TOBACCO_SEASON.end}).`)
  } else {
    conditions.push(policy.status === 'waiting_period'
      ? 'This policy is in its waiting period — claims arising during it are not payable.'
      : 'Cover is in force from the commencement date shown, subject to the terms appended.')
    conditions.push('Premiums must be kept up to date; a lapsed policy carries no cover until reinstated.')
    if (policy.dependants.length > 0) {
      conditions.push(`This policy covers the policyholder and the ${policy.dependants.length} dependant${policy.dependants.length === 1 ? '' : 's'} named above only.`)
    }
  }
  conditions.push('Familiarize Yourself With The Following Terms and Conditions')
  doc.setFontSize(9)
  const condLead = (doc.getFontSize() * doc.getLineHeightFactor() * 25.4) / 72
  const condLines = conditions.flatMap(c => doc.splitTextToSize(`• ${c}`, pageWidth - 32) as string[])
  ensureRoom(12 + condLines.length * condLead)
  sectionBand('POLICY CONDITIONS')
  doc.setFontSize(9)
  doc.setTextColor(...TEXT)
  for (const line of condLines) {
    doc.text(line, 14, y)
    y += condLead
  }

  // Anchor the closing block to the foot of page 1 — drawn straight after
  // the conditions it floated mid-sheet and left the bottom third blank.
  // Only needs ~9mm; if the page is already full it flows just past the
  // last line rather than stranding the copyright alone on a fresh page.
  ensureRoom(10)
  const footerY = Math.max(y + 5, pageHeight - 14)
  doc.setDrawColor(220, 226, 240)
  doc.line(14, footerY, pageWidth - 14, footerY)
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text(`Copyright © ${COMPANY_NAME}. All rights reserved.`, 14, footerY + 3.5)

  // Add new page for Terms and Conditions - page 2 is for terms only
  doc.addPage()
  const termsStartY = 3

  // The product's Terms and Conditions are part of the contract — they
  // flow on from here, whatever the product.
  drawTermsPages(doc, { name: policy.productName, category }, termsStartY)

  return doc
}

/** Same report as a base64 payload (no data: URI prefix), for attaching to
 *  an outgoing email or storing to the policies bucket from api/. */
export async function getPolicyReportPdfBase64(policy: Policy, client: Client, category: string, cfg: LetterheadContact): Promise<string> {
  const doc = await buildPolicyReportDoc(policy, client, category, cfg)
  return doc.output('datauristring').split(',')[1]
}
