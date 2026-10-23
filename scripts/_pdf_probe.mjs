import { jsPDF } from 'jspdf'

const doc = new jsPDF()
const pageWidth = doc.internal.pageSize.getWidth()
const MARGIN = 14
const GAP = 6
const colW = (pageWidth - MARGIN * 2 - GAP) / 2
const xOf = (c) => MARGIN + c * (colW + GAP)

const paras = [
  'WHEREAS the Insured named in the Schedules hereto (hereinafter called the "Insured") has applied to Motions Microinsurance Company (Private) Limited as mentioned on the schedule hereto (hereinafter called the "Insurer/Motions or the Company") for a policy of Field to Floor Tobacco insurance.',
  'The claim must be lodged as soon as possible after a loss has occurred and within 24 hours. The farmer will notify Motions through online, office calls or visits or through various channels as will be availed.',
  '2. Claims arising from war, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power.',
  'Eligibility Requirements — The cover is open to all residents in Zimbabwe, and Zimbabweans who are resident in the diaspora — subject to approval by the Microinsurer.',
]

// Mirror drawTermsPages: split BEFORE changing font, then draw at 6pt.
let fontSize = 7
let fontStyle = 'bold'
doc.setFont('helvetica', fontStyle)
doc.setFontSize(fontSize)

const overflows = []
function para(text) {
  const lines = doc.splitTextToSize(text, colW - 2)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6)
  for (const line of lines) {
    const tw = doc.getTextWidth(line)
    if (tw > colW - 1) overflows.push(`PARA tw=${tw.toFixed(1)} col=${colW.toFixed(1)} :: ${line.slice(0, 80)}`)
  }
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6)
}
function heading(text) {
  const lines = doc.splitTextToSize(text, colW)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7)
  for (const line of lines) {
    const tw = doc.getTextWidth(line)
    if (tw > colW + 0.5) overflows.push(`HEAD tw=${tw.toFixed(1)} col=${colW.toFixed(1)} :: ${line}`)
  }
}

heading('TERMS AND CONDITIONS')
for (const p of paras) {
  heading('Exclusions')
  para(p)
}
console.log('colW', colW.toFixed(1), 'x1', xOf(1).toFixed(1))
console.log('overflows', overflows.length)
console.log(overflows.join('\n') || 'none')

// Letterhead vs body: right block extent
doc.setFontSize(8)
doc.setFont('helvetica', 'normal')
const phones = ['+263 780 086 175', '+263 780 086 176', '+263 780 086 177']
let ry = 11
ry += 4
const addr = doc.splitTextToSize('24 Midlothian Avenue, Eastlea, Harare, Zimbabwe', 70)
ry += addr.length * 4
ry += phones.length * 4
ry += 4
console.log('letterhead bottom y', ry, 'content starts', 32, ry > 30 ? 'COLLIDES' : 'clear')
