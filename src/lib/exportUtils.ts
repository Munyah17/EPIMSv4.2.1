// xlsx/jspdf are heavy (xlsx ~150kB, jspdf+autotable+html2canvas ~350kB) and
// most visits to a page with export buttons never click one — dynamic
// import() keeps them out of the page's own chunk entirely, fetched only
// when a user actually exports something.
import type { Policy, Client } from '../types'
import { formatDate } from './dateUtils'
import { getNotifSettings } from './mailService'

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function csvEscape(value: unknown): string {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportToCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const lines = [headers.map(csvEscape).join(','), ...rows.map(r => r.map(csvEscape).join(','))]
  triggerDownload(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), filename)
}

export async function exportToExcel(filename: string, sheetName: string, headers: string[], rows: (string | number)[][]) {
  const XLSX = await import('xlsx')
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31))
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
  triggerDownload(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename)
}

export async function exportToPdf(filename: string, title: string, headers: string[], rows: (string | number)[][], subtitle?: string) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF()
  doc.setFontSize(16)
  doc.text(title, 14, 18)
  if (subtitle) {
    doc.setFontSize(10)
    doc.setTextColor(120)
    doc.text(subtitle, 14, 25)
  }
  autoTable(doc, {
    head: [headers],
    body: rows.map(r => r.map(String)),
    startY: subtitle ? 30 : 24,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [65, 105, 225] },
  })
  doc.save(filename)
}

const AGRICULTURE_COVER = ['Barn Fire', 'Hail Storm', 'Wind Storm']
const BRAND_BLUE: [number, number, number] = [65, 105, 225]
const BRAND_RED: [number, number, number] = [200, 30, 40]
const MUTED: [number, number, number] = [107, 126, 153]
const TEXT: [number, number, number] = [15, 28, 46]

/** Builds the policy report/certificate PDF (overview, policyholder
 *  detail, dependants, key terms, and — agriculture only — the defined
 *  perils covered) and returns the jsPDF doc, so callers can either save
 *  it to disk or pull it out as a base64 attachment for email. Not offered
 *  for funeral packages — funeral policies use a different document
 *  elsewhere in the flow. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildPolicyReportDoc(policy: Policy, client: Client, category: string): Promise<any> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF()
  const insurerName = policy.insurer ?? 'the insurer'
  const pageWidth = doc.internal.pageSize.getWidth()
  const cfg = getNotifSettings()

  // Header band — blue with a thin red accent underline (Motions brand
  // colours), plus company contact details if configured (Settings ->
  // Notifications -> Company Details) rather than a guessed address/phone.
  doc.setFillColor(...BRAND_BLUE)
  doc.rect(0, 0, pageWidth, 24, 'F')
  doc.setFillColor(...BRAND_RED)
  doc.rect(0, 24, pageWidth, 1.5, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(15)
  doc.text('MOTIONS', 14, 12)
  doc.setFontSize(9)
  doc.text('POLICY REPORT', 14, 19)
  doc.setFontSize(9)
  doc.text(policy.policyNumber, pageWidth - 14, 15, { align: 'right' })
  doc.setTextColor(...TEXT)

  let y = 31
  const contactLine = [cfg.companyAddress, cfg.companyPhone, cfg.companyEmail].filter(Boolean).join('  ·  ')
  if (contactLine) {
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text(contactLine, 14, y)
    doc.setTextColor(...TEXT)
    y += 6
  }
  y += 3

  const sectionHeading = (n: number, title: string) => {
    doc.setFontSize(12)
    doc.setTextColor(...BRAND_BLUE)
    doc.text(`${n}.  ${title}`, 14, y)
    doc.setDrawColor(220, 226, 240)
    doc.line(14, y + 2, pageWidth - 14, y + 2)
    doc.setTextColor(...TEXT)
    y += 9
  }

  sectionHeading(1, 'OVERVIEW')
  autoTable(doc, {
    startY: y,
    head: [['Policy No.', 'Client', 'Product', 'Premium', 'Status', 'Start Date']],
    body: [[
      policy.policyNumber, policy.clientName, policy.productName,
      `$${policy.premium.toFixed(2)}`, policy.status.toUpperCase(), formatDate(policy.startDate),
    ]],
    styles: { fontSize: 9 },
    headStyles: { fillColor: BRAND_BLUE },
    margin: { left: 14, right: 14 },
  })
  y = (doc as any).lastAutoTable.finalY + 10

  sectionHeading(2, 'POLICY DETAILS')
  doc.setFontSize(10)
  const leftRows: [string, string][] = [
    ['Date of Birth', formatDate(client.dob)],
    ['ID Number', client.nationalId],
    ['Phone Number', client.phone],
    ['Address', client.address || '—'],
  ]
  const rightRows: [string, string][] = [
    ['Package', policy.productName],
    ['Premium', `$${policy.premium.toFixed(2)}`],
    ['Renewal Date', formatDate(policy.endDate)],
    ['Sum Insured', `$${policy.coverAmount.toLocaleString()}`],
  ]
  const rowY = y
  leftRows.forEach(([label, value], i) => {
    doc.setTextColor(...MUTED)
    doc.text(`${label}:`, 14, rowY + i * 6.5)
    doc.setTextColor(...TEXT)
    doc.text(value, 50, rowY + i * 6.5)
  })
  rightRows.forEach(([label, value], i) => {
    doc.setTextColor(...MUTED)
    doc.text(`${label}:`, 115, rowY + i * 6.5)
    doc.setTextColor(...TEXT)
    doc.text(value, 150, rowY + i * 6.5)
  })
  y = rowY + leftRows.length * 6.5 + 8

  sectionHeading(3, 'POLICY DEPENDANTS')
  if (policy.dependants.length === 0) {
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    doc.text('No dependants on this policy.', 14, y)
    doc.setTextColor(...TEXT)
    y += 8
  } else {
    autoTable(doc, {
      startY: y,
      head: [['Name', 'Relationship', 'Date of Birth', 'ID / Birth Record No.']],
      body: policy.dependants.map(d => [d.name, d.relationship, formatDate(d.dob), d.nationalId]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: BRAND_BLUE },
      margin: { left: 14, right: 14 },
      foot: [['A dependant\'s plan can never exceed the policyholder\'s own premium or cover amount.']],
      footStyles: { fillColor: [255, 255, 255], textColor: MUTED, fontSize: 7, fontStyle: 'italic' },
    })
    y = (doc as any).lastAutoTable.finalY + 8
  }

  const keyTermsSection = () => {
    sectionHeading(category === 'agriculture' ? 5 : 4, 'KEY TERMS AND CONDITIONS')
    doc.setFontSize(8.5)
    doc.setTextColor(...MUTED)
    const terms = doc.splitTextToSize(
      `This policy is subject to the full Policy Terms and Conditions of ${insurerName}, available at any ${insurerName} office nationwide or on request. Cover incepts on the start date above, subject to any applicable waiting period. Claims must be reported as soon as reasonably possible and are subject to verification. Premiums must be kept up to date for cover to remain in force — a lapsed policy may require reinstatement. This document is a summary and does not itself constitute the full policy contract.`,
      pageWidth - 28,
    )
    doc.text(terms, 14, y)
    doc.setTextColor(...TEXT)
    y += terms.length * 4 + 8
  }

  // Agriculture-specific numbering: Section 4 is Cover Provided, Section 5
  // is Key Terms and Conditions — swapped from the generic order so the
  // perils covered are front and centre for this policy type.
  if (category === 'agriculture') {
    if (policy.growerNumber) {
      doc.setFontSize(9.5)
      doc.setTextColor(...MUTED)
      doc.text('Grower Number:', 14, y)
      doc.setTextColor(...TEXT)
      doc.text(policy.growerNumber, 50, y)
      y += 8
    }
    sectionHeading(4, 'COVER PROVIDED')
    doc.setFillColor(...BRAND_RED)
    doc.setFontSize(9.5)
    AGRICULTURE_COVER.forEach((peril, i) => {
      doc.circle(15.5, y + i * 5.5 - 1.3, 0.9, 'F')
      doc.text(peril, 19, y + i * 5.5)
    })
    y += AGRICULTURE_COVER.length * 5.5 + 4
    keyTermsSection()
  } else {
    keyTermsSection()
  }

  const pageHeight = doc.internal.pageSize.getHeight()
  doc.setFontSize(7.5)
  doc.setTextColor(...MUTED)
  doc.text(`Generated ${formatDate(new Date())} · Tariqify IMS`, 14, pageHeight - 10)

  return doc
}

/** Downloads the policy report as a PDF file. */
export async function exportPolicyReport(policy: Policy, client: Client, category: string) {
  const doc = await buildPolicyReportDoc(policy, client, category)
  doc.save(`${policy.policyNumber}-Policy-Report.pdf`)
}

/** Same report as a base64 payload (no data: URI prefix), for attaching to
 *  an outgoing email rather than downloading it. */
export async function getPolicyReportPdfBase64(policy: Policy, client: Client, category: string): Promise<string> {
  const doc = await buildPolicyReportDoc(policy, client, category)
  return doc.output('datauristring').split(',')[1]
}
