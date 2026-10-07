import { useState, useEffect, useMemo } from 'react'
import type { ToastMessage } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import type { ApiDeveloper } from '../lib/db'
import { exportToCsv, exportToExcelMulti, exportReportToPdf, exportToWord } from '../lib/exportUtils'
import {
  buildReport, formatCell, DATASETS, GROUP_OPTIONS, STATUS_OPTIONS, CATEGORY_OPTIONS,
  type ReportDataset, type ReportFilters, type GroupBy, type ReportData,
} from '../lib/reportBuilder'
import { BarChart, DonutChart, LineChart } from '../components/reports/ReportCharts'
import { POLICY_SOURCES, policySourceLabel } from '../lib/policySources'
import type { Policy, Claim, Payment, Client, Product, AppUser } from '../types'
import { formatDate, toIsoDate } from '../lib/dateUtils'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

type PeriodPreset = 'all' | 'month' | 'last_month' | 'quarter' | 'year' | 'custom'
type ChartKind = 'bar' | 'donut' | 'line'

const PERIODS: { value: PeriodPreset; label: string }[] = [
  { value: 'all', label: 'All Time' },
  { value: 'month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'custom', label: 'Custom Range' },
]

/** The filters each dataset actually has dimensions for. */
const FILTER_FIELDS: Record<ReportDataset, (keyof ReportFilters)[]> = {
  policies: ['agentId', 'productId', 'category', 'status', 'source'],
  claims: ['agentId', 'productId', 'category', 'status'],
  payments: ['agentId', 'productId', 'category', 'status', 'method'],
  clients: ['agentId', 'status'],
  agents: ['productId', 'category', 'source'],
  digital_agents: ['productId', 'category'],
  products: ['category', 'source', 'agentId'],
  sources: ['category', 'agentId'],
}

function periodRange(preset: PeriodPreset, from: string, to: string): { from?: string; to?: string } {
  const now = new Date()
  const iso = (d: Date) => toIsoDate(d)
  switch (preset) {
    case 'month': return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)) }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: iso(start), to: iso(end) }
    }
    case 'quarter': {
      const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
      return { from: iso(qStart) }
    }
    case 'year': return { from: `${now.getFullYear()}-01-01` }
    case 'custom': return { from: from || undefined, to: to || undefined }
    default: return {}
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')

export default function Reports({ showToast }: Props) {
  const [dataset, setDataset] = useState<ReportDataset>('policies')
  const [period, setPeriod] = useState<PeriodPreset>('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [filters, setFilters] = useState<ReportFilters>({})
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [chartKind, setChartKind] = useState<ChartKind>('bar')
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortAsc, setSortAsc] = useState(false)
  const [exporting, setExporting] = useState(false)

  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    Promise.all([
      db.policies.list(), db.claims.list(), db.payments.list(), db.clients.list(),
      db.staff.list(), db.products.list(), db.developerApi.listDevelopers(),
    ]).then(([policiesRes, claimsRes, paymentsRes, clientsRes, staffRes, productsRes, devsRes]) => {
      // A failed dataset still builds a report off what did load, but the
      // user must be told the figures are partial rather than complete.
      if ([policiesRes, claimsRes, paymentsRes, clientsRes, staffRes, productsRes, devsRes].some(r => r.error)) {
        showToast('error', 'Some report data could not be loaded — figures may be incomplete.')
      }
      setData({
        policies: (policiesRes.data ?? []) as Policy[],
        claims: (claimsRes.data ?? []) as Claim[],
        payments: (paymentsRes.data ?? []) as Payment[],
        clients: (clientsRes.data ?? []) as Client[],
        staff: (staffRes.data ?? []) as AppUser[],
        products: (productsRes.data ?? []) as Product[],
        developers: (devsRes.data ?? []) as ApiDeveloper[],
      })
      setLoading(false)
    }).catch(() => { setLoadError(true); setLoading(false) })
  }, [showToast])

  const report = useMemo(() => {
    if (!data) return null
    const { from, to } = periodRange(period, fromDate, toDate)
    return buildReport(dataset, data, { ...filters, from, to }, groupBy)
  }, [data, dataset, filters, groupBy, period, fromDate, toDate])

  const sortedRows = useMemo(() => {
    if (!report) return []
    if (sortCol === null) return report.rows
    const kind = report.columns[sortCol]?.kind
    const dir = sortAsc ? 1 : -1
    return [...report.rows].sort((a, b) =>
      kind === 'text'
        ? String(a[sortCol]).localeCompare(String(b[sortCol])) * dir
        : ((Number(a[sortCol]) || 0) - (Number(b[sortCol]) || 0)) * dir)
  }, [report, sortCol, sortAsc])

  if (loading) return <div className="panel"><div className="empty-state">Loading reports…</div></div>
  if (loadError || !data) return <div className="panel"><div className="empty-state">Report data could not be loaded. Check your connection and refresh.</div></div>

  const activeFields = FILTER_FIELDS[dataset]
  const groupOptions = GROUP_OPTIONS[dataset] ?? []
  const statuses = STATUS_OPTIONS[dataset] ?? []
  const methods = [...new Set((data?.payments ?? []).map(p => p.method))].sort()
  const agents = data ? data.staff.filter(s => s.active) : []
  const devAgents = data ? data.developers.filter(d => d.agentProfileId) : []
  const clientsChartIsCount = dataset === 'clients'

  const setFilter = (key: keyof ReportFilters, value: string) =>
    setFilters(prev => ({ ...prev, [key]: value || undefined }))

  const switchDataset = (d: ReportDataset) => {
    setDataset(d)
    setGroupBy('none')
    setFilters({})
    setSortCol(null)
  }

  const filterSummary = () => {
    const parts: string[] = []
    const { from, to } = periodRange(period, fromDate, toDate)
    parts.push(from || to ? `Period: ${from ?? '…'} to ${to ?? '…'}` : 'Period: all time')
    if (filters.agentId) {
      const name = agents.find(a => a.id === filters.agentId)?.name
        ?? devAgents.find(d => d.agentProfileId === filters.agentId)?.companyName
      parts.push(`Agent: ${name ?? filters.agentId}`)
    }
    if (filters.productId) parts.push(`Product: ${data?.products.find(p => p.id === filters.productId)?.name ?? filters.productId}`)
    if (filters.category) parts.push(`Category: ${filters.category}`)
    if (filters.status) parts.push(`Status: ${filters.status}`)
    if (filters.source) parts.push(`Channel: ${policySourceLabel(filters.source)}`)
    if (filters.method) parts.push(`Method: ${filters.method}`)
    return parts.join('  ·  ')
  }

  const handleExport = async (format: 'PDF' | 'Excel' | 'CSV' | 'Word') => {
    if (!report) return
    setExporting(true)
    const dateStamp = toIsoDate(new Date())
    const base = `report-${dataset}${groupBy !== 'none' ? `-by-${groupBy}` : ''}-${dateStamp}`
    const headers = report.columns.map(c => c.label)
    // Excel gets raw numeric cells; text formats get formatted strings.
    const rowsText = report.rows.map(r => r.map((v, i) => formatCell(v, report.columns[i]?.kind ?? 'text')))
    const subtitle = `${filterSummary()}  ·  Generated ${formatDate(new Date())} by Motions IMS`

    try {
      if (format === 'CSV') {
        exportToCsv(`${base}.csv`, headers, rowsText)
      } else if (format === 'Excel') {
        await exportToExcelMulti(`${base}.xlsx`, [
          { name: 'Summary', headers: ['Metric', 'Value'], rows: report.stats.map(s => [s.label, s.value]) },
          { name: 'Report', headers, rows: report.rows },
        ])
      } else if (format === 'PDF') {
        await exportReportToPdf(`${base}.pdf`, report.title, subtitle, report.stats, headers, rowsText)
      } else {
        exportToWord(`${base}.doc`, report.title, subtitle, [
          { heading: 'Summary', headers: ['Metric', 'Value'], rows: report.stats.map(s => [s.label, s.value]) },
          { heading: 'Report Data', headers, rows: rowsText },
        ])
      }
      showToast('success', `${report.title} exported as ${format}.`)
    } catch {
      showToast('error', `Failed to export as ${format}.`)
    }
    setExporting(false)
  }

  return (
    <div className="panel">
      {/* Report type */}
      <div className="tabs" style={{ flexWrap: 'wrap' }}>
        {DATASETS.map(d => (
          <button key={d.value} className={`tab${dataset === d.value ? ' active' : ''}`} onClick={() => switchDataset(d.value)}>{d.label}</button>
        ))}
      </div>

      {/* Filters + grouping + export */}
      <div className="filter-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select className="filter-select" value={period} onChange={e => setPeriod(e.target.value as PeriodPreset)}>
          {PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        {period === 'custom' && (
          <>
            <input type="date" className="form-control" style={{ width: 'auto' }} value={fromDate} onChange={e => setFromDate(e.target.value)} />
            <span style={{ color: 'var(--muted)' }}>to</span>
            <input type="date" className="form-control" style={{ width: 'auto' }} value={toDate} onChange={e => setToDate(e.target.value)} />
          </>
        )}

        {activeFields.includes('agentId') && (
          <select className="filter-select" value={filters.agentId ?? ''} onChange={e => setFilter('agentId', e.target.value)}>
            <option value="">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            {devAgents.map(d => <option key={d.id} value={d.agentProfileId}>{d.companyName} (API)</option>)}
          </select>
        )}
        {activeFields.includes('productId') && (
          <select className="filter-select" value={filters.productId ?? ''} onChange={e => setFilter('productId', e.target.value)}>
            <option value="">All products</option>
            {(data?.products ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {activeFields.includes('category') && (
          <select className="filter-select" value={filters.category ?? ''} onChange={e => setFilter('category', e.target.value)}>
            <option value="">All categories</option>
            {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{cap(c)}</option>)}
          </select>
        )}
        {activeFields.includes('status') && (
          <select className="filter-select" value={filters.status ?? ''} onChange={e => setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {statuses.map(s => <option key={s} value={s}>{cap(s)}</option>)}
          </select>
        )}
        {activeFields.includes('source') && (
          <select className="filter-select" value={filters.source ?? ''} onChange={e => setFilter('source', e.target.value)}>
            <option value="">All channels</option>
            {POLICY_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        )}
        {activeFields.includes('method') && (
          <select className="filter-select" value={filters.method ?? ''} onChange={e => setFilter('method', e.target.value)}>
            <option value="">All methods</option>
            {methods.map(m => <option key={m} value={m}>{cap(m)}</option>)}
          </select>
        )}

        {groupOptions.length > 0 && (
          <select className="filter-select" value={groupBy} onChange={e => { setGroupBy(e.target.value as GroupBy); setSortCol(null) }}>
            {groupOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn btn-ghost btn-sm" disabled={exporting} onClick={() => handleExport('PDF')}>↓ PDF</button>
          <button className="btn btn-ghost btn-sm" disabled={exporting} onClick={() => handleExport('Excel')}>↓ Excel</button>
          <button className="btn btn-ghost btn-sm" disabled={exporting} onClick={() => handleExport('Word')}>↓ Word</button>
          <button className="btn btn-ghost btn-sm" disabled={exporting} onClick={() => handleExport('CSV')}>↓ CSV</button>
        </div>
      </div>

      {report && (
        <>
          {/* Headline stats */}
          <div className="stats-grid" style={{ gridTemplateColumns: `repeat(${Math.min(report.stats.length, 4)}, 1fr)` }}>
            {report.stats.map(s => (
              <div key={s.label} className="stat-card">
                <div className="stat-body">
                  <div className="stat-value">{s.value}</div>
                  <div className="stat-label">{s.label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Charts */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginTop: '1.5rem' }}>
            <div className="card">
              <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 className="card-title">Breakdown</h3>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['bar', 'donut'] as ChartKind[]).map(k => (
                    <button key={k} className={`btn btn-ghost btn-sm${chartKind === k ? ' active' : ''}`}
                      style={chartKind === k ? { color: 'var(--blue)' } : undefined}
                      onClick={() => setChartKind(k)}>{k === 'bar' ? '▤ Bars' : '◔ Donut'}</button>
                  ))}
                </div>
              </div>
              {chartKind === 'donut'
                ? <DonutChart data={report.chart} money={!clientsChartIsCount} />
                : <BarChart data={report.chart} money={!clientsChartIsCount} />}
            </div>
            <div className="card">
              <div className="card-header"><h3 className="card-title">Monthly Trend</h3></div>
              <LineChart data={report.trend} money={dataset !== 'clients'} />
            </div>
          </div>

          {/* Data table */}
          <div className="card" style={{ marginTop: '1.5rem' }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="card-title">{report.title}</h3>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sortedRows.length} row{sortedRows.length === 1 ? '' : 's'} — click a column to sort</span>
            </div>
            <div className="tbl-scroll">
              <table className="table">
                <thead>
                  <tr>
                    {report.columns.map((c, i) => (
                      <th key={c.label} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                        onClick={() => { if (sortCol === i) setSortAsc(!sortAsc); else { setSortCol(i); setSortAsc(c.kind === 'text') } }}>
                        {c.label}{sortCol === i ? (sortAsc ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.length === 0 ? (
                    <tr><td colSpan={report.columns.length} className="td-empty">Nothing matches the current filters.</td></tr>
                  ) : sortedRows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => {
                        const kind = report.columns[ci]?.kind ?? 'text'
                        return (
                          <td key={ci} style={{ textAlign: kind === 'text' ? 'left' : 'right', whiteSpace: 'nowrap' }}>
                            {formatCell(cell, kind)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
