// xlsx/jspdf are heavy (xlsx ~150kB, jspdf+autotable+html2canvas ~350kB) and
// most visits to a page with export buttons never click one — dynamic
// import() keeps them out of the page's own chunk entirely, fetched only
// when a user actually exports something.

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
