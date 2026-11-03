/** Branded billing documents — invoice, quotation and requisition PDFs
 *  on the same letterhead + palette as the policy report, so every piece
 *  of paper the office hands out looks like one company. jsPDF loads on
 *  demand, same lazy-import pattern as exportUtils. */
import type { Invoice, Quotation, Requisition } from '../types'
import { formatDate, formatDateTime } from './dateUtils'
import { getNotifSettings } from './mailService'
import { COMPANY_NAME } from './company'
import { documentDisplayName } from './storage'

function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

async function newDoc() {
  const [{ jsPDF }, { default: autoTable }, { MOTIONS_LOGO_PNG_BASE64 }, { drawLetterhead, NAVY, MUTED, TEXT, BRAND_BLUE }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('../assets/motionsLogo'),
    import('./policyReportPdf'),
  ])
  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()
  const y = drawLetterhead(doc, pageWidth, MOTIONS_LOGO_PNG_BASE64, COMPANY_NAME, getNotifSettings())
  return { doc, autoTable, pageWidth, y, NAVY, MUTED, TEXT, BRAND_BLUE }
}

function titleBlock(doc: import('jspdf').jsPDF,
  title: string, docNo: string, pageWidth: number, y: number, NAVY: [number, number, number]): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.setTextColor(...NAVY)
  doc.text(title, 14, y)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text(`No: ${docNo}`, pageWidth - 14, y, { align: 'right' })
  doc.setDrawColor(...NAVY)
  doc.setLineWidth(0.6)
  doc.line(14, y + 3, pageWidth - 14, y + 3)
  return y + 9
}

// ── INVOICE ─────────────────────────────────────────────────────────
export async function exportInvoicePdf(inv: Invoice): Promise<void> {
  const { doc, autoTable, pageWidth, y, NAVY, MUTED, TEXT } = await newDoc()
  let cy = titleBlock(doc, 'TAX INVOICE', inv.invoiceNumber, pageWidth, y, NAVY)

  doc.setFontSize(9); doc.setTextColor(...MUTED); doc.text('Bill to:', 14, cy)
  doc.setTextColor(...TEXT); doc.setFontSize(11); doc.setFont('helvetica', 'bold')
  doc.text(inv.groupName ?? inv.customerName ?? inv.clientName, 14, cy + 5)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)

  doc.setTextColor(...MUTED)
  doc.text(`Issued: ${formatDate(inv.issuedAt)}`, pageWidth - 14, cy, { align: 'right' })
  doc.text(`Due: ${inv.dueDate ? formatDate(inv.dueDate) : '—'}`, pageWidth - 14, cy + 4, { align: 'right' })
  if (inv.period && inv.period !== 'CUSTOM') {
    doc.text(`Period: ${inv.period}`, pageWidth - 14, cy + 8, { align: 'right' })
  }
  cy += 14

  autoTable(doc, {
    startY: cy,
    head: [['Description', 'Qty', 'Amount (USD)']],
    body: [[
      inv.notes || (inv.policyNumber ? `Insurance premium — policy ${inv.policyNumber}` : 'Insurance services'),
      inv.heads > 0 ? `${inv.heads} heads` : '1',
      money(inv.amount),
    ]],
    styles: { fontSize: 10, cellPadding: 3 },
    headStyles: { fillColor: NAVY, textColor: 255 },
    columnStyles: { 0: { cellWidth: 'auto' }, 1: { cellWidth: 30, halign: 'center' }, 2: { cellWidth: 40, halign: 'right' } },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cy = (doc as any).lastAutoTable?.finalY ?? cy + 20

  doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...TEXT)
  doc.text('Total due:', pageWidth - 14 - 42, cy + 8)
  doc.text(money(inv.amount), pageWidth - 14, cy + 8, { align: 'right' })
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED)
  doc.text(`Status: ${inv.status.toUpperCase()}`, pageWidth - 14, cy + 14, { align: 'right' })

  doc.setFontSize(8); doc.setTextColor(...MUTED)
  doc.text(`${COMPANY_NAME} — please quote the invoice number when paying.`, 14, 285)
  doc.save(`${inv.invoiceNumber}.pdf`)
}

// ── QUOTATION ───────────────────────────────────────────────────────
export async function exportQuotationPdf(q: Quotation): Promise<void> {
  const { doc, autoTable, pageWidth, y, NAVY, MUTED, TEXT } = await newDoc()
  let cy = titleBlock(doc, 'QUOTATION', q.quotationNumber, pageWidth, y, NAVY)

  doc.setFontSize(9); doc.setTextColor(...MUTED); doc.text('Prepared for:', 14, cy)
  doc.setTextColor(...TEXT); doc.setFontSize(11); doc.setFont('helvetica', 'bold')
  doc.text(q.clientName, 14, cy + 5)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)

  doc.setTextColor(...MUTED)
  doc.text(`Issued: ${formatDate(q.createdAt)}`, pageWidth - 14, cy, { align: 'right' })
  if (q.validUntil) doc.text(`Valid until: ${formatDate(q.validUntil)}`, pageWidth - 14, cy + 4, { align: 'right' })
  cy += 14

  const body: string[][] = [[
    q.productName || 'Insurance cover',
    q.coverAmount != null ? money(q.coverAmount) : '—',
    money(q.premium),
  ]]
  if (q.policyDetails?.dependants?.length) {
    body.push([`Covered dependants: ${q.policyDetails.dependants.map(d => d.name).join(', ')}`, '', ''])
  }
  if (q.policyDetails?.growerNumber) {
    body.push([`Grower ${q.policyDetails.growerNumber}${q.policyDetails.hectarage ? ` · ${q.policyDetails.hectarage} ha` : ''}${q.policyDetails.contractor ? ` · ${q.policyDetails.contractor}` : ''}`, '', ''])
  }
  autoTable(doc, {
    startY: cy,
    head: [['Cover', 'Sum Insured', 'Premium (USD)']],
    body,
    styles: { fontSize: 10, cellPadding: 3 },
    headStyles: { fillColor: NAVY, textColor: 255 },
    columnStyles: { 1: { cellWidth: 40, halign: 'right' }, 2: { cellWidth: 40, halign: 'right' } },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cy = (doc as any).lastAutoTable?.finalY ?? cy + 20

  if (q.notes) {
    doc.setFontSize(9); doc.setTextColor(...MUTED)
    doc.text('Notes:', 14, cy + 8)
    doc.setTextColor(...TEXT)
    const lines = doc.splitTextToSize(q.notes, pageWidth - 28)
    doc.text(lines, 14, cy + 13)
    cy += 13 + lines.length * 4
  }
  doc.setFontSize(9); doc.setTextColor(...MUTED)
  doc.text(`Status: ${q.status.toUpperCase()}`, pageWidth - 14, cy + 8, { align: 'right' })
  doc.text('This quotation is an offer, not cover — cover begins once a policy is issued and the first premium is paid.', 14, 285)
  doc.save(`${q.quotationNumber}.pdf`)
}

// ── REQUISITION ─────────────────────────────────────────────────────
export async function exportRequisitionPdf(r: Requisition): Promise<void> {
  const { doc, autoTable, pageWidth, y, NAVY, MUTED, TEXT } = await newDoc()
  let cy = titleBlock(doc, 'REQUISITION', r.requisitionNumber, pageWidth, y, NAVY)

  doc.setFontSize(9); doc.setTextColor(...MUTED); doc.text('Payee:', 14, cy)
  doc.setTextColor(...TEXT); doc.setFontSize(11); doc.setFont('helvetica', 'bold')
  doc.text(r.payee, 14, cy + 5)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text(`Requested: ${formatDateTime(r.createdAt)}${r.requestedByName ? ` by ${r.requestedByName}` : ''}`, pageWidth - 14, cy, { align: 'right' })
  cy += 14

  autoTable(doc, {
    startY: cy,
    head: [['Purpose', 'Category', 'Amount (USD)']],
    body: [[r.purpose, r.category, money(r.amount)]],
    styles: { fontSize: 10, cellPadding: 3 },
    headStyles: { fillColor: NAVY, textColor: 255 },
    columnStyles: { 1: { cellWidth: 40 }, 2: { cellWidth: 40, halign: 'right' } },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cy = (doc as any).lastAutoTable?.finalY ?? cy + 20

  autoTable(doc, {
    startY: cy + 4,
    head: [['Decision trail', '']],
    body: [
      ['Status', r.status.toUpperCase()],
      ['Requested by', r.requestedByName ?? '—'],
      ['Decided by', r.approvedByName ? `${r.approvedByName}${r.approvedAt ? ` — ${formatDateTime(r.approvedAt)}` : ''}` : '—'],
      ...(r.paidAt ? [['Paid', formatDateTime(r.paidAt)]] : []),
      ...(r.notes ? [['Notes', r.notes]] : []),
    ],
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: NAVY, textColor: 255 },
    columnStyles: { 0: { cellWidth: 40, fontStyle: 'bold' } },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cy = (doc as any).lastAutoTable?.finalY ?? cy + 20

  // Supporting documents land as a manifest page — names + how to pull
  // each file from the documents store.
  if (r.attachments?.length) {
    cy += 6
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...TEXT)
    doc.text(`Attached supporting documents (${r.attachments.length}):`, 14, cy)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED)
    r.attachments.forEach((path, i) => {
      doc.text(`${i + 1}. ${documentDisplayName(path)}`, 18, cy + 5 + i * 5)
    })
    cy += 5 + r.attachments.length * 5
    doc.text('Files are stored in the secure documents store under requisitions/ — open them from the Requisitions table.', 14, cy + 2)
  }

  doc.setFontSize(8); doc.setTextColor(...MUTED)
  doc.text(`${COMPANY_NAME} — internal expenditure record.`, 14, 285)
  doc.save(`${r.requisitionNumber}.pdf`)
}
