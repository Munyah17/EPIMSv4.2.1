// xlsx/jspdf are heavy (xlsx ~150kB, jspdf+autotable+html2canvas ~350kB) and
// most visits to a page with export buttons never click one — dynamic
// import() keeps them out of the page's own chunk entirely, fetched only
// when a user actually exports something.
import type { Policy, Client, ClaimAssessment, PolicyAssessment } from '../types'
import { formatDate } from './dateUtils'
import { getNotifSettings } from './mailService'
import { getDocumentUrl } from './storage'

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
/** Standard excess applied unless a product has its own excess configured. */
const DEFAULT_POLICY_EXCESS = '15% of loss'
const BRAND_BLUE: [number, number, number] = [65, 105, 225]
const BRAND_RED: [number, number, number] = [200, 30, 40]
const MUTED: [number, number, number] = [107, 126, 153]
const TEXT: [number, number, number] = [15, 28, 46]
const NAVY: [number, number, number] = [33, 46, 108]
const TABLE_HEAD: [number, number, number] = [191, 200, 232]

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
async function buildPolicyReportDoc(policy: Policy, client: Client, category: string): Promise<any> {
  const [{ jsPDF }, { default: autoTable }, { MOTIONS_LOGO_PNG_BASE64 }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), import('../assets/motionsLogo'),
  ])
  const doc = new jsPDF()
  const insurerName = policy.insurer ?? 'the insurer'
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const cfg = getNotifSettings()

  const ensureRoom = (need: number) => {
    if (y + need > pageHeight - 16) { doc.addPage(); y = 20 }
  }

  // Real Motions Microinsurance logo (square source image), sized to sit
  // level with the address block on the right.
  doc.addImage(MOTIONS_LOGO_PNG_BASE64, 'PNG', 14, 8, 20, 20)

  // Company contact details, right-aligned — only from what's actually
  // configured (Settings -> Notifications -> Company Details). A wrong
  // address/phone on an official document is worse than an empty one, so
  // nothing here is guessed or hardcoded.
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
    const addrLines = doc.splitTextToSize(cfg.companyAddress, 70)
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
  if (cfg.companyEmail) { doc.text(`Email: ${cfg.companyEmail}`, pageWidth - 14, ry, { align: 'right' }); ry += 4 }

  let y = 28
  doc.setFontSize(9.5)
  doc.setTextColor(...TEXT)
  doc.text(client.name, 14, y)
  y += 5
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text(`Generated ${formatDate(new Date())}`, 14, y)
  y += 4.5
  doc.text(`Commencement Date: ${formatDate(policy.startDate)}`, 14, y)
  doc.setTextColor(...TEXT)
  y += 8

  autoTable(doc, {
    startY: y,
    head: [['Amount Paid', 'Payment Date', 'Expiration Date']],
    body: [[`$${policy.premium.toFixed(2)}`, formatDate(policy.lastPaymentDate), formatDate(policy.nextPaymentDate)]],
    styles: { fontSize: 9, lineColor: [220, 226, 240], lineWidth: 0.2 },
    headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold' },
    theme: 'grid',
    margin: { left: 14, right: 14 },
  })
  y = (doc as any).lastAutoTable.finalY + 8

  const sectionBand = (title: string) => {
    ensureRoom(14)
    doc.setFillColor(...NAVY)
    doc.rect(14, y, pageWidth - 28, 8, 'F')
    doc.setFontSize(10)
    doc.setTextColor(255, 255, 255)
    doc.text(title, 14 + (pageWidth - 28) / 2, y + 5.5, { align: 'center' })
    doc.setTextColor(...TEXT)
    y += 12
  }

  sectionBand('POLICY INFORMATION')
  autoTable(doc, {
    startY: y,
    head: [['Policy Number', 'Policy Package', 'Monthly Premium', 'Cover', 'Currency', 'Status']],
    body: [[
      policy.policyNumber, policy.productName, `$${policy.premium.toFixed(2)}`,
      `$${policy.coverAmount.toLocaleString()}`, 'USD', policy.status.toUpperCase(),
    ]],
    styles: { fontSize: 8.5, lineColor: [220, 226, 240], lineWidth: 0.2 },
    headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold' },
    theme: 'grid',
    margin: { left: 14, right: 14 },
  })
  y = (doc as any).lastAutoTable.finalY + 8

  sectionBand('PERSONAL INFORMATION')
  autoTable(doc, {
    startY: y,
    head: [['Full Name', 'National ID', 'Mobile Number', 'Date of Birth', 'Registration Date']],
    body: [[client.name, client.nationalId, client.phone, formatDate(client.dob), formatDate(client.createdAt)]],
    styles: { fontSize: 8.5, lineColor: [220, 226, 240], lineWidth: 0.2 },
    headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold' },
    theme: 'grid',
    margin: { left: 14, right: 14 },
  })
  y = (doc as any).lastAutoTable.finalY + 8

  sectionBand('DEPENDANTS')
  if (policy.dependants.length === 0) {
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    doc.text('No dependants on this policy.', 14, y)
    doc.setTextColor(...TEXT)
    y += 8
  } else {
    policy.dependants.forEach(d => {
      ensureRoom(22)
      doc.setFontSize(8)
      doc.setTextColor(...NAVY)
      const header = doc.splitTextToSize(
        `FULL NAME: ${d.name}  |  NATIONAL ID: ${d.nationalId || '—'}  |  RELATIONSHIP: ${d.relationship}  |  DATE OF BIRTH: ${formatDate(d.dob)}`,
        pageWidth - 32,
      )
      doc.text(header, 18, y)
      doc.setTextColor(...TEXT)
      y += header.length * 4 + 2
      autoTable(doc, {
        startY: y,
        head: [['Policy Package', 'Monthly Premium', 'Cover', 'Currency', 'Status']],
        body: [[
          d.productName ?? policy.productName,
          `$${(d.premium ?? policy.premium).toFixed(2)}`,
          `$${policy.coverAmount.toLocaleString()}`, 'USD', policy.status.toUpperCase(),
        ]],
        styles: { fontSize: 8.5, lineColor: [220, 226, 240], lineWidth: 0.2 },
        headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold' },
        theme: 'grid',
        margin: { left: 14, right: 14 },
      })
      y = (doc as any).lastAutoTable.finalY + 6
    })
  }

  if (category === 'agriculture') {
    ensureRoom(20 + AGRICULTURE_COVER.length * 5.5)
    if (policy.growerNumber) {
      doc.setFontSize(9.5)
      doc.setTextColor(...MUTED)
      doc.text('Grower Number:', 14, y)
      doc.setTextColor(...TEXT)
      doc.text(policy.growerNumber, 50, y)
      y += 8
    }
    sectionBand('COVER PROVIDED')
    doc.setFillColor(...BRAND_RED)
    doc.setFontSize(9.5)
    AGRICULTURE_COVER.forEach((peril, i) => {
      doc.circle(15.5, y + i * 5.5 - 1.3, 0.9, 'F')
      doc.text(peril, 19, y + i * 5.5)
    })
    y += AGRICULTURE_COVER.length * 5.5 + 4
  }

  {
    const excessLines = doc.splitTextToSize(policy.excess || DEFAULT_POLICY_EXCESS, pageWidth - 32)
    ensureRoom(14 + excessLines.length * 4.5)
    sectionBand('POLICY EXCESS')
    doc.setFontSize(9)
    doc.setTextColor(...TEXT)
    doc.text(excessLines, 14, y)
    y += excessLines.length * 4.5 + 4
  }

  ensureRoom(24)
  doc.setDrawColor(220, 226, 240)
  doc.line(14, y, pageWidth - 14, y)
  y += 6
  doc.setFontSize(7.5)
  doc.setTextColor(...MUTED)
  doc.text('Disclaimer:', 14, y)
  y += 4
  const terms = doc.splitTextToSize(
    `Terms and Conditions apply, and are subject to the full Policy Terms and Conditions of ${insurerName}. Terms and Conditions can be found at www.motions.co.zw. Cover incepts on the start date above, subject to any applicable waiting period. Claims must be reported as soon as reasonably possible and are subject to verification. Premiums must be kept up to date for cover to remain in force; a lapsed policy may require reinstatement. This document is a summary and does not itself constitute the full policy contract.`,
    pageWidth - 28,
  )
  doc.text(terms, 14, y)
  y += terms.length * 4 + 4
  doc.text('Copyright © Motions Microinsurance. All rights reserved.', 14, y)

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

async function fetchImageAsDataUrl(path: string): Promise<string | null> {
  try {
    const url = await getDocumentUrl(path)
    if (!url) return null
    const res = await fetch(url)
    const blob = await res.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/** Printable record of an Agriculture Assessor's physical claim
 *  assessment — overview, description of loss, site details, comments,
 *  embedded photos (with whatever date evidence was captured), and the
 *  farmer/assessor sign-off. */
export async function exportClaimAssessmentReport(
  assessment: ClaimAssessment, claimNumber: string, policyNumber: string, clientName: string,
) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()
  const cfg = getNotifSettings()

  doc.setFillColor(...BRAND_BLUE)
  doc.rect(0, 0, pageWidth, 24, 'F')
  doc.setFillColor(...BRAND_RED)
  doc.rect(0, 24, pageWidth, 1.5, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(15)
  doc.text('MOTIONS', 14, 12)
  doc.setFontSize(9)
  doc.text('AGRICULTURE PHYSICAL ASSESSMENT REPORT', 14, 19)
  doc.text(claimNumber, pageWidth - 14, 15, { align: 'right' })
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

  const kvRows = (rows: [string, string][]) => {
    doc.setFontSize(10)
    rows.forEach(([l, v], i) => {
      doc.setTextColor(...MUTED)
      doc.text(`${l}:`, 14, y + i * 6.5)
      doc.setTextColor(...TEXT)
      doc.text(v, 60, y + i * 6.5)
    })
    y += rows.length * 6.5 + 8
  }

  sectionHeading(1, 'CLAIM OVERVIEW')
  kvRows([
    ['Claim Number', claimNumber], ['Policy Number', policyNumber], ['Client', clientName],
    ['Assessor', assessment.assessorName], ['Submitted', assessment.submittedAt ? formatDate(assessment.submittedAt) : '—'],
  ])

  sectionHeading(2, 'DESCRIPTION OF LOSS')
  doc.setFontSize(9)
  const desc = doc.splitTextToSize(assessment.descriptionOfLoss || '—', pageWidth - 28)
  doc.text(desc, 14, y)
  y += desc.length * 4.5 + 6

  sectionHeading(3, "FARMER'S STATEMENT")
  doc.setFontSize(9)
  const statement = doc.splitTextToSize(assessment.farmerStatement || '—', pageWidth - 28)
  doc.text(statement, 14, y)
  y += statement.length * 4.5 + 6

  sectionHeading(4, 'SITE DETAILS')
  kvRows([
    ['Crop Population', assessment.cropPopulation || '—'],
    ['Crop Stage', assessment.cropStage || '—'],
    ['Barn Capacity', assessment.barnCapacity || '—'],
    ['GPS Coordinates', assessment.gpsLat !== undefined ? `${assessment.gpsLat.toFixed(6)}, ${assessment.gpsLng?.toFixed(6)}` : '—'],
  ])

  sectionHeading(5, "ASSESSOR'S COMMENTS")
  doc.setFontSize(9)
  const comments = doc.splitTextToSize(assessment.assessorComments || '—', pageWidth - 28)
  doc.text(comments, 14, y)
  y += comments.length * 4.5 + 8

  if (assessment.photos.length > 0) {
    if (y > 230) { doc.addPage(); y = 20 }
    sectionHeading(6, 'PHOTOGRAPHIC EVIDENCE')
    for (const photo of assessment.photos) {
      if (y > 220) { doc.addPage(); y = 20 }
      doc.setFontSize(9)
      doc.setTextColor(...TEXT)
      doc.text(photo.label, 14, y)
      const dateLabel = photo.exifDate || photo.visibleDateStamp
      doc.setFontSize(7.5)
      doc.setTextColor(...MUTED)
      if (dateLabel) doc.text(`Captured: ${dateLabel}`, 14, y + 4.5)
      if (photo.aiFlagged) {
        doc.setTextColor(...BRAND_RED)
        doc.text('⚠ Flagged for review', 60, y + 4.5)
      }
      const dataUrl = await fetchImageAsDataUrl(photo.path)
      if (dataUrl) {
        try {
          const format = dataUrl.includes('image/png') ? 'PNG' : 'JPEG'
          doc.addImage(dataUrl, format, 14, y + 7, 60, 45)
        } catch { /* skip if the image can't be decoded into the PDF */ }
      }
      doc.setTextColor(...TEXT)
      y += 58
    }
  }

  if (assessment.farmerSignature || assessment.assessorSignature) {
    if (y > 220) { doc.addPage(); y = 20 }
    sectionHeading(7, 'SIGN-OFF')
    if (assessment.farmerSignature) {
      doc.setFontSize(8.5)
      doc.setTextColor(...MUTED)
      doc.text('Farmer Signature', 14, y)
      try { doc.addImage(assessment.farmerSignature, 'PNG', 14, y + 2, 60, 20) } catch { /**/ }
    }
    if (assessment.assessorSignature) {
      doc.setFontSize(8.5)
      doc.setTextColor(...MUTED)
      doc.text('Assessor Signature', 110, y)
      try { doc.addImage(assessment.assessorSignature, 'PNG', 110, y + 2, 60, 20) } catch { /**/ }
    }
    y += 26
  }

  const pageHeight = doc.internal.pageSize.getHeight()
  doc.setFontSize(7.5)
  doc.setTextColor(...MUTED)
  doc.text(`Generated ${formatDate(new Date())} · Tariqify IMS`, 14, pageHeight - 10)

  doc.save(`${claimNumber}-Assessment-Report.pdf`)
}

/** Printable record of a pre-loss baseline assessment — the same report
 *  family as exportClaimAssessmentReport, but for what's established on a
 *  farm before any claim exists rather than the damage evidence after one. */
export async function exportPolicyAssessmentReport(
  assessment: PolicyAssessment, policyNumber: string, clientName: string,
) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()
  const cfg = getNotifSettings()

  doc.setFillColor(...BRAND_BLUE)
  doc.rect(0, 0, pageWidth, 24, 'F')
  doc.setFillColor(...BRAND_RED)
  doc.rect(0, 24, pageWidth, 1.5, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(15)
  doc.text('MOTIONS', 14, 12)
  doc.setFontSize(9)
  doc.text(assessment.subjectType === 'vehicle' ? 'VEHICLE PRE-LOSS ASSESSMENT REPORT' : 'AGRICULTURE PRE-LOSS ASSESSMENT REPORT', 14, 19)
  doc.text(policyNumber, pageWidth - 14, 15, { align: 'right' })
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

  const kvRows = (rows: [string, string][]) => {
    doc.setFontSize(10)
    rows.forEach(([l, v], i) => {
      doc.setTextColor(...MUTED)
      doc.text(`${l}:`, 14, y + i * 6.5)
      doc.setTextColor(...TEXT)
      doc.text(v, 60, y + i * 6.5)
    })
    y += rows.length * 6.5 + 8
  }

  sectionHeading(1, 'POLICY OVERVIEW')
  kvRows([
    ['Policy Number', policyNumber], ['Client', clientName],
    ['Assessor', assessment.assessorName], ['Recorded', formatDate(assessment.createdAt)],
  ])

  if (assessment.subjectType === 'vehicle') {
    sectionHeading(2, 'VEHICLE DETAILS')
    kvRows([
      ['Registration Number', assessment.registrationNumber || '—'],
      ['Make / Model', [assessment.vehicleMake, assessment.vehicleModel].filter(Boolean).join(' ') || '—'],
      ['Odometer Reading', assessment.odometerReading || '—'],
      ['Existing Damage', assessment.existingDamage || '—'],
      ['GPS Coordinates', assessment.gpsLat !== undefined ? `${assessment.gpsLat.toFixed(6)}, ${assessment.gpsLng?.toFixed(6)}` : '—'],
    ])
  } else {
    sectionHeading(2, 'FARM / CROP DETAILS')
    kvRows([
      ['Crop Type', assessment.cropType || '—'],
      ['Crop Population', assessment.cropPopulation || '—'],
      ['Plant Date', assessment.plantDate ? formatDate(assessment.plantDate) : '—'],
      ['GPS Coordinates', assessment.gpsLat !== undefined ? `${assessment.gpsLat.toFixed(6)}, ${assessment.gpsLng?.toFixed(6)}` : '—'],
    ])
  }

  sectionHeading(3, 'NOTES')
  doc.setFontSize(9)
  const notes = doc.splitTextToSize(assessment.notes || '—', pageWidth - 28)
  doc.text(notes, 14, y)
  y += notes.length * 4.5 + 8

  if (assessment.photos.length > 0) {
    if (y > 230) { doc.addPage(); y = 20 }
    sectionHeading(4, 'PHOTOGRAPHIC EVIDENCE')
    for (const photo of assessment.photos) {
      if (y > 220) { doc.addPage(); y = 20 }
      doc.setFontSize(9)
      doc.setTextColor(...TEXT)
      doc.text(photo.label, 14, y)
      const dateLabel = photo.exifDate || photo.visibleDateStamp
      doc.setFontSize(7.5)
      doc.setTextColor(...MUTED)
      if (dateLabel) doc.text(`Captured: ${dateLabel}`, 14, y + 4.5)
      const dataUrl = await fetchImageAsDataUrl(photo.path)
      if (dataUrl) {
        try {
          const format = dataUrl.includes('image/png') ? 'PNG' : 'JPEG'
          doc.addImage(dataUrl, format, 14, y + 7, 60, 45)
        } catch { /* skip if the image can't be decoded into the PDF */ }
      }
      doc.setTextColor(...TEXT)
      y += 58
    }
  }

  const pageHeight = doc.internal.pageSize.getHeight()
  doc.setFontSize(7.5)
  doc.setTextColor(...MUTED)
  doc.text(`Generated ${formatDate(new Date())} · Tariqify IMS`, 14, pageHeight - 10)

  doc.save(`${policyNumber}-PreLoss-Assessment-Report.pdf`)
}
