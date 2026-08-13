// xlsx/jspdf are heavy (xlsx ~150kB, jspdf+autotable+html2canvas ~350kB) and
// most visits to a page with export buttons never click one — dynamic
// import() keeps them out of the page's own chunk entirely, fetched only
// when a user actually exports something.
import type { Policy, Client } from '../types'
import { formatDate } from './dateUtils'

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

/** Structured policy report/certificate: overview, policyholder detail,
 *  dependants, key terms, and (agriculture only) the defined perils
 *  covered. Not offered for funeral packages — funeral policies use a
 *  different document elsewhere in the flow. */
export async function exportPolicyReport(policy: Policy, client: Client, category: string) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF()
  const insurerName = policy.insurer ?? 'the insurer'
  let y = 18

  doc.setFontSize(16)
  doc.text('POLICY REPORT — OVERVIEW', 14, y)
  y += 10

  autoTable(doc, {
    startY: y,
    head: [['Policy No.', 'Client', 'Product', 'Premium', 'Status', 'Start Date']],
    body: [[
      policy.policyNumber, policy.clientName, policy.productName,
      `$${policy.premium.toFixed(2)}`, policy.status.toUpperCase(), formatDate(policy.startDate),
    ]],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [65, 105, 225] },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 12

  doc.setFontSize(13)
  doc.text('1. POLICY DETAILS', 14, y)
  y += 8
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
    doc.setTextColor(107, 126, 153)
    doc.text(`${label}:`, 14, rowY + i * 7)
    doc.setTextColor(15, 28, 46)
    doc.text(value, 55, rowY + i * 7)
  })
  rightRows.forEach(([label, value], i) => {
    doc.setTextColor(107, 126, 153)
    doc.text(`${label}:`, 115, rowY + i * 7)
    doc.setTextColor(15, 28, 46)
    doc.text(value, 155, rowY + i * 7)
  })
  doc.setTextColor(15, 28, 46)
  y = rowY + leftRows.length * 7 + 10

  doc.setFontSize(13)
  doc.text('2. POLICY DEPENDANTS', 14, y)
  y += 4
  if (policy.dependants.length === 0) {
    y += 6
    doc.setFontSize(10)
    doc.setTextColor(107, 126, 153)
    doc.text('No dependants on this policy.', 14, y)
    doc.setTextColor(15, 28, 46)
    y += 8
  } else {
    autoTable(doc, {
      startY: y + 4,
      head: [['Name', 'Relationship', 'Date of Birth', 'ID Number']],
      body: policy.dependants.map(d => [d.name, d.relationship, formatDate(d.dob), d.nationalId]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [65, 105, 225] },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 10
  }

  doc.setFontSize(13)
  doc.text('3. KEY TERMS AND CONDITIONS', 14, y)
  y += 8
  doc.setFontSize(9)
  const terms = doc.splitTextToSize(
    `This policy is subject to the full Policy Terms and Conditions of ${insurerName}, available at any ${insurerName} office nationwide or on request. Cover incepts on the start date above, subject to any applicable waiting period. Claims must be reported as soon as reasonably possible and are subject to verification. Premiums must be kept up to date for cover to remain in force — a lapsed policy may require reinstatement. This document is a summary and does not itself constitute the full policy contract.`,
    182,
  )
  doc.text(terms, 14, y)
  y += terms.length * 4.5 + 8

  if (category === 'agriculture') {
    doc.setFontSize(13)
    doc.text('4. COVER PROVIDED', 14, y)
    y += 8
    doc.setFontSize(10)
    AGRICULTURE_COVER.forEach((peril, i) => {
      doc.text(`•  ${peril}`, 14, y + i * 6)
    })
  }

  doc.save(`${policy.policyNumber}-Policy-Report.pdf`)
}
