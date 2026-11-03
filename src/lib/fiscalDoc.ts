import { jsPDF } from 'jspdf'
import type { FdmsReceipt, FdmsDocType } from '../types'
import { formatDateTime } from './dateUtils'

const DOC_TITLE: Record<FdmsDocType, string> = {
  FiscalInvoice: 'FISCAL TAX INVOICE',
  CreditNote: 'FISCAL CREDIT NOTE',
  DebitNote: 'FISCAL DEBIT NOTE',
}

/** ZIMRA's public verification portal — a scanned/entered QR resolves
 *  "Invoice is Valid" only once FDMS has accepted the document. */
const VERIFY_PORTAL = 'https://fdms.zimra.co.zw'

/** QR payload: ZIMRA's own qrData when the live/test API returned it,
 *  else a portal URL carrying the verification fields. */
function qrPayload(r: FdmsReceipt): string {
  if (r.qrData) return r.qrData
  const q = new URLSearchParams()
  if (r.verificationCode) q.set('verificationCode', r.verificationCode)
  if (r.globalNo != null) q.set('receiptGlobalNo', String(r.globalNo))
  if (r.deviceId) q.set('deviceId', r.deviceId)
  return `${VERIFY_PORTAL}${q.size ? `?${q}` : ''}`
}

/**
 * The fiscal document ZIMRA's approval flow wants — a printable Fiscal
 * Tax Invoice / Credit Note / Debit Note imprinted with the verifiable
 * QR code, global number and verification code. Generated client-side so
 * test-environment samples can be produced before live credentials land.
 */
export async function downloadFiscalDocument(r: FdmsReceipt, original?: FdmsReceipt): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const M = 18 // margin

  // ── Letterhead ──
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16)
  doc.text('Motions Microinsurance', M, 18)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90)
  doc.text('VAT Registered Operator — virtual fiscal device', M, 24)

  // ── Title band ──
  doc.setFillColor('#1E2952')
  doc.rect(M, 30, W - M * 2, 12, 'F')
  doc.setTextColor(255); doc.setFontSize(13); doc.setFont('helvetica', 'bold')
  doc.text(DOC_TITLE[r.docType] ?? 'FISCAL DOCUMENT', W / 2, 38, { align: 'center' })
  doc.setTextColor(0)

  let y = 52
  doc.setFontSize(10); doc.setFont('helvetica', 'bold')
  doc.text('Document No:', M, y); doc.setFont('helvetica', 'normal')
  doc.text(r.receiptNumber, M + 30, y)
  doc.setFont('helvetica', 'bold'); doc.text('Date:', W - M - 55, y)
  doc.setFont('helvetica', 'normal'); doc.text(formatDateTime(r.createdAt), W - M, y, { align: 'right' })

  y += 7
  doc.setFont('helvetica', 'bold'); doc.text('Buyer:', M, y)
  doc.setFont('helvetica', 'normal'); doc.text(r.clientName || '—', M + 30, y)

  // Credit/debit notes state what they adjust and why — ZIMRA requires it.
  if (r.docType !== 'FiscalInvoice') {
    y += 7
    doc.setFont('helvetica', 'bold'); doc.text('Adjusts:', M, y)
    doc.setFont('helvetica', 'normal')
    doc.text(`${original?.receiptNumber ?? '—'}${original?.globalNo != null ? `  (Global No ${original.globalNo})` : ''}`, M + 30, y)
    if (r.reason) {
      y += 7
      doc.setFont('helvetica', 'bold'); doc.text('Reason:', M, y)
      doc.setFont('helvetica', 'normal'); doc.text(r.reason, M + 30, y)
    }
  }

  // ── Amount table ──
  y += 10
  const vat = r.vatAmount ?? Math.round(r.amount * 0.155 / 1.155 * 100) / 100
  const net = Math.round((r.amount - vat) * 100) / 100
  doc.setFillColor('#F0F0F0'); doc.rect(M, y, W - M * 2, 8, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9)
  doc.text('Description', M + 3, y + 5.5)
  doc.text('Amount (USD)', W - M - 3, y + 5.5, { align: 'right' })
  y += 8
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10)
  doc.text(`${r.docType === 'FiscalInvoice' ? 'Insurance premium — invoice' : `${r.docType === 'CreditNote' ? 'Credit against' : 'Debit against'} invoice`} ${original?.receiptNumber ?? r.receiptNumber}`, M + 3, y + 6)
  doc.text(`$${r.amount.toFixed(2)}`, W - M - 3, y + 6, { align: 'right' })
  y += 12
  doc.line(M, y, W - M, y)
  y += 7
  doc.text('Net of VAT', M + 3, y); doc.text(`$${net.toFixed(2)}`, W - M - 3, y, { align: 'right' })
  y += 6
  doc.text(`VAT @ 15.5%`, M + 3, y); doc.text(`$${vat.toFixed(2)}`, W - M - 3, y, { align: 'right' })
  y += 7
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
  doc.text(r.docType === 'CreditNote' ? 'Total credited' : 'Total', M + 3, y)
  doc.text(`$${r.amount.toFixed(2)}`, W - M - 3, y, { align: 'right' })
  doc.setFontSize(10); doc.setFont('helvetica', 'normal')

  // ── Fiscal verification block ──
  y += 14
  doc.setDrawColor(30, 41, 82); doc.setLineWidth(0.4)
  doc.rect(M, y, W - M * 2, 52)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(30, 41, 82)
  doc.text('ZIMRA FISCAL VERIFICATION', M + 4, y + 7)
  doc.setTextColor(0); doc.setFontSize(9)

  const rows: Array<[string, string]> = [
    ['Device ID', r.deviceId ?? '—'],
    ['Fiscal Day', r.fiscalDay ?? '—'],
    ['Receipt Counter', r.receiptCounter != null ? String(r.receiptCounter) : '—'],
    ['Global No', r.globalNo != null ? String(r.globalNo) : '—'],
    ['Verification Code', r.verificationCode ?? '—'],
  ]
  let fy = y + 14
  for (const [k, v] of rows) {
    doc.setFont('helvetica', 'bold'); doc.text(`${k}:`, M + 4, fy)
    doc.setFont('helvetica', 'normal'); doc.text(v, M + 42, fy)
    fy += 6
  }

  // The QR imprint — the artefact ZIMRA says makes a document verifiable.
  try {
    const QRCode = (await import('qrcode')).default
    const dataUrl = await QRCode.toDataURL(qrPayload(r), { width: 400, margin: 1 })
    doc.addImage(dataUrl, 'PNG', W - M - 44, y + 5, 36, 36)
    doc.setFontSize(7); doc.setTextColor(90)
    doc.text(`Scan to verify — ${VERIFY_PORTAL}`, W - M - 44, y + 45)
    doc.setTextColor(0); doc.setFontSize(10)
  } catch {
    doc.setFontSize(8); doc.setTextColor(150)
    doc.text(`Verify at ${VERIFY_PORTAL} with the code above`, W - M - 4, y + 45, { align: 'right' })
    doc.setTextColor(0); doc.setFontSize(10)
  }

  // ── Footer ──
  doc.setFontSize(8); doc.setTextColor(110)
  doc.text('Generated by Tariqify IMS. This document is valid only when its QR code resolves on the ZIMRA FDMS portal.', M, 285)

  doc.save(`${r.receiptNumber}-fiscal.pdf`)
}
