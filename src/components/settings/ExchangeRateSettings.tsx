import { useState, useEffect, useCallback } from 'react'
import type { ToastMessage } from '../../types'
import { db } from '../../lib/db'
import { useAuth } from '../../contexts/AuthContext'
import { formatDate } from '../../lib/dateUtils'
import {
  isStale, rateAgeLabel, validateRate, convertUsdToZig, RATE_STALE_AFTER_DAYS,
  type ExchangeRate,
} from '../../lib/exchangeRate'
import RateTrendChart from './RateTrendChart'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

interface Suggestion {
  available: boolean
  officialRate?: number | null
  parallelRate?: number | null
  asOf?: string
  confidence?: 'low' | 'medium' | 'high'
  basis?: string
  note?: string
}

/** Today in YYYY-MM-DD, from local time rather than UTC -- an effective date
 *  is a calendar day here, not an instant. */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function ExchangeRateSettings({ showToast }: Props) {
  const { user } = useAuth()
  const canEdit = user?.role === 'super_admin'

  const [current, setCurrent] = useState<ExchangeRate | null>(null)
  const [history, setHistory] = useState<ExchangeRate[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [rateInput, setRateInput] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(todayIso())
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  const load = useCallback(async () => {
    const [cur, hist] = await Promise.all([db.exchangeRates.current(), db.exchangeRates.history()])
    setCurrent(cur.data)
    setHistory(hist.data)
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const handleSave = async () => {
    if (!canEdit) return
    const checked = validateRate(rateInput)
    if (!checked.ok) { setError(checked.error); return }
    if (!effectiveDate) { setError('Choose the date this rate applies from.'); return }
    setError(null)
    setSaving(true)
    const { error: saveError } = await db.exchangeRates.set({
      rate: checked.rate,
      effectiveDate,
      source: 'manual',
      note: note.trim() || undefined,
      setBy: user?.name,
    })
    setSaving(false)
    if (saveError) { showToast('error', saveError); return }
    setRateInput('')
    setNote('')
    setSuggestion(null)
    await load()
    showToast('success', `Rate saved: 1 USD = ${checked.rate} ZiG from ${formatDate(effectiveDate)}.`)
  }

  const handleSuggest = async () => {
    setSuggesting(true)
    setSuggestion(null)
    try {
      const res = await fetch('/api/estimate-exchange-rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentRate: current?.rate }),
      })
      const data = await res.json().catch(() => null) as Suggestion | null
      setSuggestion(data ?? { available: false, note: 'No suggestion was returned.' })
    } catch {
      setSuggestion({ available: false, note: 'Could not reach the suggestion service.' })
    } finally {
      setSuggesting(false)
    }
  }

  if (loading) return <div className="card"><p style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</p></div>

  const stale = isStale(current)
  const preview = validateRate(rateInput)

  return (
    <>
      <div className={`card${stale ? ' card-warning' : ''}`} style={{ marginBottom: 16 }}>
        <div className="card-header">
          <span className="card-title">USD / ZiG Exchange Rate</span>
          {current && (
            <span className={`pill ${stale ? 'pill-lapsed' : 'pill-active'}`} style={{ fontSize: 10 }}>
              {rateAgeLabel(current)}
            </span>
          )}
        </div>

        {current ? (
          <div className="rate-current">
            <span className="rate-current-value">1 USD = {current.rate} ZiG</span>
            <span className="rate-current-meta">
              Effective {formatDate(current.effectiveDate)}
              {current.setBy ? ` · set by ${current.setBy}` : ''}
              {current.source === 'estimate' ? ' · unverified estimate' : ''}
            </span>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0 10px' }}>
            No rate has been set. ZiG payments are refused until one is.
          </p>
        )}

        {stale && current && (
          <p style={{ fontSize: 12, color: 'var(--warning-text, #92400E)', margin: '2px 0 10px' }}>
            This rate is {RATE_STALE_AFTER_DAYS} days old or more. Rates are published weekly — check it before taking ZiG payments.
          </p>
        )}

        {canEdit ? (
          <>
            <div className="rate-form">
              <div className="form-group">
                <label>ZiG per 1 USD</label>
                <input
                  className={`form-control${error ? ' input-error' : ''}`}
                  type="number" step="0.0001" min="0" inputMode="decimal"
                  value={rateInput}
                  onChange={e => { setRateInput(e.target.value); setError(null) }}
                  placeholder={current ? String(current.rate) : 'e.g. 26.4'}
                />
              </div>
              <div className="form-group">
                <label>Effective from</label>
                <input
                  className="form-control" type="date"
                  value={effectiveDate}
                  onChange={e => setEffectiveDate(e.target.value)}
                />
              </div>
              <div className="form-group" style={{ flex: 2 }}>
                <label>Note <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
                <input
                  className="form-control" type="text" maxLength={120}
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Where this figure came from"
                />
              </div>
            </div>

            {error && <p className="form-error" style={{ marginTop: 2 }}>{error}</p>}

            {preview.ok && (
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0' }}>
                A $10.00 premium would be charged as ZiG {convertUsdToZig(10, preview.rate).toFixed(2)}.
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Rate'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleSuggest} disabled={suggesting}>
                {suggesting ? 'Checking…' : 'Suggest a figure'}
              </button>
            </div>

            {suggestion && (
              <div className="rate-suggestion">
                {suggestion.available ? (
                  <>
                    <div className="rate-suggestion-head">
                      <span>Suggested — not verified</span>
                      <span className="rate-suggestion-confidence">{suggestion.confidence} confidence</span>
                    </div>
                    <div className="rate-suggestion-figures">
                      {suggestion.officialRate != null && (
                        <button
                          type="button" className="rate-suggestion-figure"
                          onClick={() => setRateInput(String(suggestion.officialRate))}
                        >
                          Official ≈ {suggestion.officialRate} <span>use</span>
                        </button>
                      )}
                      {suggestion.parallelRate != null && (
                        <button
                          type="button" className="rate-suggestion-figure"
                          onClick={() => setRateInput(String(suggestion.parallelRate))}
                        >
                          Parallel ≈ {suggestion.parallelRate} <span>use</span>
                        </button>
                      )}
                    </div>
                    <p className="rate-suggestion-basis">
                      As of {suggestion.asOf || 'unknown'}. {suggestion.basis}
                    </p>
                    <p className="rate-suggestion-warning">
                      This has no live market access and may be well out of date. Check it against the published rate before saving.
                    </p>
                  </>
                ) : (
                  <p className="rate-suggestion-basis">{suggestion.note}</p>
                )}
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            Only a super admin can change the exchange rate.
          </p>
        )}
      </div>

      {history.length > 0 && (
        <div className="card">
          <div className="card-header"><span className="card-title">Rate History</span></div>
          <RateTrendChart history={history} />
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table className="data-table">
              <thead>
                <tr><th>Effective</th><th>ZiG per USD</th><th>Set by</th><th>Note</th></tr>
              </thead>
              <tbody>
                {history.slice(0, 12).map(r => (
                  <tr key={r.id}>
                    <td>{formatDate(r.effectiveDate)}</td>
                    <td>{r.rate}{r.source === 'estimate' ? ' *' : ''}</td>
                    <td>{r.setBy || '—'}</td>
                    <td style={{ color: 'var(--muted)' }}>{r.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {history.some(r => r.source === 'estimate') && (
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>* unverified estimate</p>
          )}
        </div>
      )}
    </>
  )
}
