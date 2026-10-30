// xlsx/jspdf are heavy (xlsx ~150kB, jspdf+autotable+html2canvas ~350kB) and
// most visits to a page with export buttons never click one — dynamic
// import() keeps them out of the page's own chunk entirely, fetched only
// when a user actually exports something.
import type { Policy, Client, ClaimAssessment, PolicyAssessment } from '../types'
import { formatDate } from './dateUtils'
import { getNotifSettings } from './mailService'
import { getDocumentUrl } from './storage'
import { reverseGeocode } from './geocode'
import { COMPANY_NAME } from './company'

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

/**
 * Workbook with several sheets — used by the Reports page to ship a
 * Summary sheet (the stat cards) alongside the data itself, so a board
 * pack needs no second file.
 */
export async function exportToExcelMulti(
  filename: string,
  sheets: { name: string; headers: string[]; rows: (string | number)[][] }[],
) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]), s.name.slice(0, 31) || 'Sheet')
  }
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
  triggerDownload(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename)
}

/**
 * Report-grade PDF, laid out like the policy document: the Motions
 * letterhead, a title block, the active filters spelled out (so a
 * printed report can't be mistaken for a different cut of the data),
 * the headline stats as a boxed strip, then the data table.
 *
 * Wide tables (the 17-column treaty layout) get landscape +
 * horizontalPageBreak: the columns flow onto a second page set at full
 * readable width instead of being crushed into one cramped grid — the
 * same row appears across the page sets, so reading order is preserved.
 */
export async function exportReportToPdf(
  filename: string,
  title: string,
  subtitle: string,
  stats: { label: string; value: string }[],
  headers: string[],
  rows: (string | number)[][],
  /** Wide reports (the 17-column treaty layout) need the extra width.
   *  repeatColumns: the identity columns re-printed on every overflow
   *  page set — a single repeat drops Surname on later sets and puts
   *  whatever follows in its visual slot. */
  opts?: { landscape?: boolean; repeatColumns?: number[] },
) {
  const [{ jsPDF }, { default: autoTable }, { MOTIONS_LOGO_PNG_BASE64 }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), import('../assets/motionsLogo'),
  ])
  const doc = new jsPDF({ orientation: opts?.landscape ? 'landscape' : 'portrait' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const cfg = getNotifSettings()

  let y = drawLetterhead(doc, pageWidth, MOTIONS_LOGO_PNG_BASE64, COMPANY_NAME, cfg)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(...NAVY)
  doc.text(title.toUpperCase(), 14, y)
  y += 2.5
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(...MUTED)
  const sub = doc.splitTextToSize(`${subtitle} — generated ${formatDate(new Date())}`, pageWidth - 28)
  doc.text(sub, 14, y)
  y += sub.length * 4 + 6

  if (stats.length > 0) {
    autoTable(doc, {
      head: [stats.map(s => s.label)],
      body: [stats.map(s => s.value)],
      startY: y,
      styles: { fontSize: 8.5, halign: 'center', cellPadding: 2 },
      headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold' },
      theme: 'grid',
      margin: { left: 14, right: 14 },
    })
    y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 8
  }

  autoTable(doc, {
    head: [headers],
    // Column 0 identifies WHO the row is — printed in capitals like every
    // other captured name in the system, whatever case it was keyed in.
    body: rows.map(r => r.map((c, i) => i === 0 ? String(c).toUpperCase() : String(c))),
    startY: y,
    styles: {
      fontSize: opts?.landscape ? 7.5 : 8.5,
      cellPadding: 1.8,
      valign: 'middle',
      lineColor: [220, 226, 240], lineWidth: 0.15,
      textColor: TEXT,
      minCellWidth: opts?.landscape ? 14 : undefined,
    },
    headStyles: { fillColor: TABLE_HEAD, textColor: TEXT, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 249, 253] },
    theme: 'grid',
    margin: { left: 14, right: 14, top: 16, bottom: 14 },
    // Columns that don't fit flow to the next page set — the same rows,
    // next columns — instead of being squeezed unreadably onto one page.
    // Column 0 (the member's name) repeats on every set so each half
    // still tells you WHO the row is about.
    horizontalPageBreak: opts?.landscape ?? false,
    horizontalPageBreakRepeat: opts?.landscape ? (opts.repeatColumns ?? 0) : undefined,
    didParseCell: data => {
      // Numbers right-align like every other money column in the system.
      const v = data.cell.raw
      if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v.replace(/[$,]/g, ''))) && data.section === 'body') {
        data.cell.styles.halign = 'right'
      }
    },
  })

  // Page numbers on every page.
  const total = doc.getNumberOfPages()
  for (let p = 1; p <= total; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text(`${COMPANY_NAME} — ${title} · Page ${p} of ${total}`, pageWidth / 2, pageHeight - 8, { align: 'center' })
  }

  doc.save(filename)
}

/**
 * Word export without a docx dependency: a styled HTML document saved with
 * a .doc extension. Word (and LibreOffice/Google Docs) open it natively —
 * headings, a real table, everything — which is all a printed report needs.
 */
export function exportToWord(
  filename: string,
  title: string,
  subtitle: string,
  sections: { heading?: string; headers: string[]; rows: (string | number)[][] }[],
) {
  const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const table = (headers: string[], rows: (string | number)[][]) => `
    <table border="1" cellspacing="0" cellpadding="5" style="border-collapse:collapse;width:100%;font-size:10pt;">
      <thead><tr>${headers.map(h => `<th style="background:#4169e1;color:#fff;text-align:left;">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:Calibri,Arial,sans-serif;">
  <h1 style="font-size:16pt;margin-bottom:2pt;">${esc(title)}</h1>
  <p style="color:#666;font-size:9pt;margin-top:0;">${esc(subtitle)}</p>
  ${sections.map(s => `${s.heading ? `<h2 style="font-size:12pt;margin:14pt 0 4pt;">${esc(s.heading)}</h2>` : ''}${table(s.headers, s.rows)}`).join('')}
</body></html>`
  triggerDownload(new Blob([html], { type: 'application/msword;charset=utf-8' }), filename)
}

/** Same window in ISO — the stored policy start/end dates must match what
 *  the document prints, so policy creation uses these, not the generic
 *  aligned-month rule. */
export const TOBACCO_SEASON_ISO = { start: '2026-11-15', end: '2027-08-31' }

// Field-to-Floor helpers live in smsText.ts — the one file both the app
// and the api/ serverless functions can import — so the SMS a client
// receives quotes exactly the per-peril schedule this document prints.
export { isTobaccoFieldToFloor, fieldToFloorCover, fieldToFloorCoverLine } from './smsText'

// The document builder, letterhead, terms pages and brand palette now
// live in policyReportPdf.ts — the server-safe half — so api/ functions
// (regenerate-policy-documents) produce the identical document without
// pulling mailService/storage/localStorage into Node.
import {
  drawLetterhead, buildPolicyReportDoc,
  BRAND_BLUE, BRAND_RED, MUTED, TEXT, NAVY, TABLE_HEAD,
} from './policyReportPdf'

/** Downloads the policy report as a PDF file. */
export async function exportPolicyReport(policy: Policy, client: Client, category: string) {
  const doc = await buildPolicyReportDoc(policy, client, category, getNotifSettings())
  doc.save(`${policy.policyNumber}-Policy-Report.pdf`)
}

/** Same report as a base64 payload (no data: URI prefix), for attaching to
 *  an outgoing email rather than downloading it. */
export async function getPolicyReportPdfBase64(policy: Policy, client: Client, category: string): Promise<string> {
  const doc = await buildPolicyReportDoc(policy, client, category, getNotifSettings())
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
  y += 2

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
    doc.setFontSize(7.5)
    doc.setTextColor(...BRAND_RED)
    doc.text('Print in colour for accurate assessment of photo evidence.', 14, y)
    doc.setTextColor(...TEXT)
    y += 7
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
      y += 28
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
  doc.text(`Generated ${formatDate(new Date())} · TariqifyIMS`, 14, pageHeight - 10)

  doc.save(`${claimNumber}-Assessment-Report.pdf`)
}

/** Printable record of a pre-loss baseline assessment — the same report
 *  family as exportClaimAssessmentReport, but for what's established on a
 *  farm before any claim exists rather than the damage evidence after one. */
export async function exportPolicyAssessmentReport(
  assessment: PolicyAssessment, policyNumber: string, clientName: string,
) {
  const [{ jsPDF }, { MOTIONS_LOGO_PNG_BASE64 }] = await Promise.all([
    import('jspdf'), import('../assets/motionsLogo'),
  ])
  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()
  const cfg = getNotifSettings()
  
  let y = drawLetterhead(doc, pageWidth, MOTIONS_LOGO_PNG_BASE64, COMPANY_NAME, cfg)
  doc.setFontSize(9.5)
  doc.setTextColor(...TEXT)
  doc.text(assessment.subjectType === 'vehicle' ? 'VEHICLE PRE-LOSS ASSESSMENT REPORT' : 'AGRICULTURE PRE-LOSS ASSESSMENT REPORT', 14, y)
  y += 2
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text(`Policy ${policyNumber}`, 14, y)
  y += 4.5
  doc.text(`Generated ${formatDate(new Date())}`, 14, y)
  doc.setTextColor(...TEXT)
  y += 2

  const pageHeightForFlow = doc.internal.pageSize.getHeight()
  const ensureRoom = (need: number) => {
    if (y + need > pageHeightForFlow - 16) { doc.addPage(); y = 20 }
  }

  // Same banded section style as the Policy Report so the two documents
  // read as one family.
  const sectionHeading = (_n: number, title: string) => {
    ensureRoom(14)
    doc.setFillColor(...NAVY)
    doc.rect(14, y, pageWidth - 28, 8, 'F')
    doc.setFontSize(10)
    doc.setTextColor(255, 255, 255)
    doc.text(title, 14 + (pageWidth - 28) / 2, y + 5.5, { align: 'center' })
    doc.setTextColor(...TEXT)
    y += 12
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

  const gpsLabel = assessment.gpsLat !== undefined && assessment.gpsLng !== undefined
    ? (() => {
        const coords = `${assessment.gpsLat.toFixed(6)}, ${assessment.gpsLng.toFixed(6)}`
        return reverseGeocode(assessment.gpsLat, assessment.gpsLng).then(place => place ? `${coords} (${place})` : coords)
      })()
    : Promise.resolve('—')

  sectionHeading(1, 'POLICY OVERVIEW')
  kvRows([
    ['Policy Number', policyNumber], ['Client', clientName],
    ['Assessor', assessment.assessorName], ['Recorded', formatDate(assessment.createdAt)],
  ])

  const resolvedGps = await gpsLabel

  if (assessment.subjectType === 'vehicle') {
    sectionHeading(2, 'VEHICLE DETAILS')
    kvRows([
      ['Registration Number', assessment.registrationNumber || '—'],
      ['Make / Model', [assessment.vehicleMake, assessment.vehicleModel].filter(Boolean).join(' ') || '—'],
      ['Odometer Reading', assessment.odometerReading || '—'],
      ['Existing Damage', assessment.existingDamage || '—'],
      ['GPS Coordinates', resolvedGps],
    ])
  } else {
    sectionHeading(2, 'FARM / CROP DETAILS')
    const barnCapacity = [
      assessment.barnHooks && `${assessment.barnHooks} hooks`,
      assessment.barnTiers && `${assessment.barnTiers} tiers`,
      assessment.barnBays && `${assessment.barnBays} bays`,
    ].filter(Boolean).join(', ')
    kvRows([
      ['Crop Type', assessment.cropType || '—'],
      ['Crop Population', assessment.cropPopulation || '—'],
      ['Plant Date', assessment.plantDate ? formatDate(assessment.plantDate) : '—'],
      ['GPS Coordinates', resolvedGps],
      ['Barn Capacity', barnCapacity || '—'],
      ['Barn Ownership', assessment.barnOwnership || '—'],
      ['Barn Usage', assessment.barnUsage || '—'],
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
    doc.setFontSize(7.5)
    doc.setTextColor(...BRAND_RED)
    doc.text('Print in colour for accurate assessment of photo evidence.', 14, y)
    doc.setTextColor(...TEXT)
    y += 7
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
      y += 28
    }
  }

  if (assessment.farmerSignature || assessment.assessorSignature) {
    if (y > 220) { doc.addPage(); y = 20 }
    sectionHeading(5, 'SIGN-OFF')
    if (assessment.farmerSignature) {
      doc.setFontSize(8.5)
      doc.setTextColor(...MUTED)
      doc.text(assessment.subjectType === 'vehicle' ? 'Client Signature' : 'Farmer Signature', 14, y)
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
  doc.text(`Generated ${formatDate(new Date())} · TariqifyIMS`, 14, pageHeight - 10)

  doc.save(`${policyNumber}-PreLoss-Assessment-Report.pdf`)
}
