/**
 * Lightweight SVG charts for the Reports page — no chart library. Three
 * shapes cover every breakdown the report engine produces:
 *   - Bars   (horizontal) for comparing groups
 *   - Donut  for share-of-total
 *   - Line   for the monthly trend
 */
import { formatCell } from '../../lib/reportBuilder'

export interface ChartDatum { label: string; value: number }

const PALETTE = ['#5b7fe8', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b']

const MONEY_FMT = (n: number) => formatCell(n, 'money')

/** Horizontal bars with the value at the end of each bar — readable at a
 *  glance and degenerates gracefully to a ranked list when labels are long. */
export function BarChart({ data, money = true }: { data: ChartDatum[]; money?: boolean }) {
  const max = Math.max(1, ...data.map(d => d.value))
  const fmt = money ? MONEY_FMT : (n: number) => n.toLocaleString()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {data.map((d, i) => (
        <div key={d.label} style={{ display: 'grid', gridTemplateColumns: '170px 1fr 90px', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textTransform: 'capitalize' }} title={d.label}>{d.label}</span>
          <div className="bar-track" style={{ height: 14 }}>
            <div className="bar-fill" style={{ width: `${(d.value / max) * 100}%`, background: PALETTE[i % PALETTE.length], height: '100%', borderRadius: 4 }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 600, textAlign: 'right' }}>{fmt(d.value)}</span>
        </div>
      ))}
      {data.length === 0 && <p className="td-empty">No data for this selection.</p>}
    </div>
  )
}

/** Share-of-total donut with a legend. */
export function DonutChart({ data, money = true }: { data: ChartDatum[]; money?: boolean }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const fmt = money ? MONEY_FMT : (n: number) => n.toLocaleString()
  const R = 54
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
      {total > 0 ? (
        <svg viewBox="0 0 140 140" width="150" height="150" role="img" aria-label="Share of total by group">
          <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="18" />
          {data.map((d, i) => {
            const frac = d.value / total
            const el = (
              <circle
                key={d.label} cx="70" cy="70" r={R} fill="none"
                stroke={PALETTE[i % PALETTE.length]} strokeWidth="18"
                strokeDasharray={`${frac * C} ${C}`}
                strokeDashoffset={-offset * C}
                transform="rotate(-90 70 70)"
              />
            )
            offset += frac
            return el
          })}
        </svg>
      ) : <p className="td-empty">No data for this selection.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.map((d, i) => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
            <span style={{ color: 'var(--muted)', textTransform: 'capitalize' }}>{d.label}</span>
            <strong>{fmt(d.value)}</strong>
            <span style={{ color: 'var(--muted)' }}>{total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Monthly trend line with area fill, y-axis anchored at zero. */
export function LineChart({ data, money = true }: { data: ChartDatum[]; money?: boolean }) {
  const fmt = money ? MONEY_FMT : (n: number) => n.toLocaleString()
  if (data.length === 0) return <p className="td-empty">No data for this selection.</p>
  if (data.length === 1) {
    return <p style={{ fontSize: 13, color: 'var(--muted)' }}>Only one month of data ({data[0].label}: {fmt(data[0].value)}) — the line needs at least two points.</p>
  }
  const W = 640, H = 180, PAD = 34
  const max = Math.max(1, ...data.map(d => d.value))
  const x = (i: number) => PAD + (i * (W - PAD * 1.4)) / (data.length - 1)
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 1.6)
  const points = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }} role="img" aria-label="Monthly trend">
      {[0.25, 0.5, 0.75, 1].map(t => (
        <g key={t}>
          <line x1={PAD} y1={y(max * t)} x2={W - 10} y2={y(max * t)} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
          <text x={PAD - 5} y={y(max * t) + 3} fontSize="8" fill="var(--muted)" textAnchor="end">{fmt(Math.round(max * t))}</text>
        </g>
      ))}
      <polygon points={`${x(0)},${y(0)} ${points} ${x(data.length - 1)},${y(0)}`} fill="rgba(91,127,232,0.15)" />
      <polyline points={points} fill="none" stroke="#5b7fe8" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (
        <g key={d.label}>
          <circle cx={x(i)} cy={y(d.value)} r="3.5" fill="#5b7fe8" />
          <text x={x(i)} y={H - 10} fontSize="8.5" fill="var(--muted)" textAnchor="middle">{d.label}</text>
        </g>
      ))}
    </svg>
  )
}
