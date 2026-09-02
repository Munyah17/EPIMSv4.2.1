import { useMemo } from 'react'
import { formatDate } from '../../lib/dateUtils'
import type { ExchangeRate } from '../../lib/exchangeRate'

interface Props {
  history: ExchangeRate[]
  height?: number
}

const PAD = { top: 12, right: 14, bottom: 24, left: 46 }

/**
 * The rate over time.
 *
 * Drawn as an SVG line rather than pulled in from a charting library: it is
 * one series of a few dozen points, and the readings are irregular (a rate is
 * entered when it is published, not on a schedule), so the x axis is spaced
 * by actual date rather than by position in the list -- a gap of three weeks
 * should look like one.
 */
export default function RateTrendChart({ history, height = 160 }: Props) {
  const points = useMemo(() => {
    return [...history]
      .filter(r => Number.isFinite(r.rate))
      .map(r => ({ ...r, t: new Date(`${r.effectiveDate}T00:00:00`).getTime() }))
      .filter(r => !Number.isNaN(r.t))
      .sort((a, b) => a.t - b.t)
  }, [history])

  if (points.length === 0) return null

  const width = 640
  const innerW = width - PAD.left - PAD.right
  const innerH = height - PAD.top - PAD.bottom

  const minT = points[0].t
  const maxT = points[points.length - 1].t
  const rates = points.map(p => p.rate)
  const minR = Math.min(...rates)
  const maxR = Math.max(...rates)
  // A flat series would otherwise divide by zero and collapse onto one edge.
  const spanR = maxR - minR || Math.max(maxR * 0.1, 1)
  const spanT = maxT - minT || 1

  const lo = minR - spanR * 0.15
  const hi = maxR + spanR * 0.15

  const x = (t: number) => PAD.left + (points.length === 1 ? innerW / 2 : ((t - minT) / spanT) * innerW)
  const y = (r: number) => PAD.top + innerH - ((r - lo) / (hi - lo)) * innerH

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(1)} ${y(p.rate).toFixed(1)}`).join(' ')
  const area = `${line} L ${x(maxT).toFixed(1)} ${(PAD.top + innerH).toFixed(1)} L ${x(minT).toFixed(1)} ${(PAD.top + innerH).toFixed(1)} Z`

  const ticks = [lo, (lo + hi) / 2, hi]
  const latest = points[points.length - 1]

  return (
    <div className="rate-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
           aria-label={`ZiG per USD over time, currently ${latest.rate}`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="rate-chart-grid" />
            <text x={PAD.left - 6} y={y(t) + 3} className="rate-chart-label" textAnchor="end">
              {t.toFixed(t < 10 ? 2 : 0)}
            </text>
          </g>
        ))}

        {points.length > 1 && <path d={area} className="rate-chart-area" />}
        <path d={line} className="rate-chart-line" />

        {points.map(p => (
          <circle key={p.id} cx={x(p.t)} cy={y(p.rate)} r={2.5} className="rate-chart-dot">
            <title>{`${formatDate(p.effectiveDate)} — ${p.rate} ZiG per USD`}</title>
          </circle>
        ))}

        <text x={PAD.left} y={height - 7} className="rate-chart-label" textAnchor="start">
          {formatDate(points[0].effectiveDate)}
        </text>
        {points.length > 1 && (
          <text x={width - PAD.right} y={height - 7} className="rate-chart-label" textAnchor="end">
            {formatDate(latest.effectiveDate)}
          </text>
        )}
      </svg>
    </div>
  )
}
