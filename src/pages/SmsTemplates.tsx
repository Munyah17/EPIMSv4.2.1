import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToastMessage, Product } from '../types'
import { db } from '../lib/db'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  SMS_TEMPLATE_EVENTS, smsTemplateEventDef, renderSmsTemplate,
  unknownPlaceholders, invalidateSmsTemplateCache,
  type SmsTemplateEvent, type SmsTemplateRow,
} from '../lib/smsTemplates'
import { sendSms } from '../lib/smsService'
import { formatDate } from '../lib/dateUtils'

/** Wording the send border (api/_lib/smsCanon.ts) strips on the way out —
 *  a saved body carrying it would go out DIFFERENT from what was typed,
 *  so the editor refuses it up front instead of letting the border
 *  silently rewrite the message. */
const BANNED_IN_TEMPLATE: { re: RegExp; label: string }[] = [
  { re: /(^|[\n.]|\s{2,})\s*REG(?:ISTRATION)?\b\s*[:\-—–|.]/i, label: 'a "REG:"/"REGISTRATION:" prefix' },
  { re: /(?:^|\s)reg(?:istered)?\.{1,2}(?!\s*(?:no\.?|number)\b)/i, label: '"reg."/"registered."' },
  { re: /motions\s+microinsurance/i, label: 'the company name (never sent in SMS bodies)' },
]

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

/**
 * SMS notification templates — Bulk SMS → Templates tab (also reachable as
 * its own page). Staff define one template per notification type, either
 * for every product ("All products") or for one product specifically; a
 * product's own template wins over the type default, and where no
 * template exists the built-in wording sends exactly as before.
 *
 * Writes land in public.sms_templates (admin-only via RLS). After every
 * save the resolver cache is invalidated so the very next notification
 * uses the new wording — in this browser AND in every server function.
 */

interface Draft {
  id: string | null
  event: SmsTemplateEvent
  productId: string | '' // '' = All products
  body: string
  active: boolean
}

const EMPTY_DRAFT: Draft = { id: null, event: 'registration_confirmation', productId: '', body: '', active: true }

export function SmsTemplatesPanel({ showToast }: Props) {
  const { hasPermission } = useAuth()
  const [templates, setTemplates] = useState<SmsTemplateRow[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [eventFilter, setEventFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [testPhone, setTestPhone] = useState('')
  const [testSending, setTestSending] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const canWrite = hasPermission('communications.send_sms')

  const productName = (id: string | null) =>
    id === null ? 'All products' : (products.find(p => p.id === id)?.name ?? 'Unknown product')

  const load = async () => {
    setLoading(true)
    setLoadError('')
    const [tplRes, prodRes] = await Promise.all([
      supabase.from('sms_templates').select('id, event_type, product_id, body, active, updated_at').order('event_type'),
      db.products.list(),
    ])
    if (tplRes.error) {
      // The table only exists once database/add_sms_templates.sql has run —
      // say so plainly instead of a bare "failed to load".
      setLoadError(/does not exist|sms_templates/i.test(tplRes.error.message)
        ? 'The sms_templates table is not in the database yet — run database/add_sms_templates.sql against Supabase, then reload this page.'
        : `Could not load templates: ${tplRes.error.message}`)
    } else {
      setTemplates((tplRes.data ?? []) as SmsTemplateRow[])
    }
    if (prodRes.error) showToast('warning', 'Could not load the product list; product names may show as ids.')
    setProducts(prodRes.data ?? [])
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [])

  // ── Editor ──────────────────────────────────────────────────────

  const startAdd = () => setDraft({ ...EMPTY_DRAFT })
  const startEdit = (t: SmsTemplateRow) =>
    setDraft({ id: t.id, event: t.event_type, productId: t.product_id ?? '', body: t.body, active: t.active })

  const def = draft ? smsTemplateEventDef(draft.event) : null
  const unknown = draft && def ? unknownPlaceholders(draft.event, draft.body) : []
  const duplicate = draft
    ? templates.some(t =>
        t.id !== draft.id
        && t.event_type === draft.event
        && (t.product_id ?? '') === draft.productId)
    : false
  const bodyTooLong = (draft?.body.length ?? 0) > 1000
  const banned = draft ? BANNED_IN_TEMPLATE.find(b => b.re.test(draft.body)) : undefined
  const draftErrors: string[] = []
  if (draft) {
    if (!draft.body.trim()) draftErrors.push('The template body is empty.')
    if (unknown.length) draftErrors.push(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map(u => `{${u}}`).join(', ')} — only the listed ones are understood.`)
    if (duplicate) draftErrors.push(`A template for this notification type and ${draft.productId ? 'product' : '"All products"'} already exists — edit that one instead.`)
    if (bodyTooLong) draftErrors.push('Over 1,000 characters — the database limit.')
    if (banned) draftErrors.push(`This body contains ${banned.label} — banned wording the send border strips anyway, so clients would get a different text than the one you typed. Remove it.`)
  }

  const preview = draft && def ? renderSmsTemplate(draft.body, def.sample) : ''
  const previewLen = preview.length
  // The gateway bills per 160-char GSM segment — multi-segment texts cost
  // per part, so the count is part of "is this wording worth it".
  const segments = Math.max(1, Math.ceil(previewLen / 160))

  /** Insert a {placeholder} at the caret — keeps the cursor usable so
   *  clicking chips in sequence just appends them one after another. */
  const insertPlaceholder = (name: string) => {
    const el = bodyRef.current
    if (!el || !draft) { setDraft(d => d && { ...d, body: d.body + `{${name}}` }); return }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const next = el.value.slice(0, start) + `{${name}}` + el.value.slice(end)
    setDraft({ ...draft, body: next })
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + name.length + 2
      el.setSelectionRange(pos, pos)
    })
  }

  const save = async () => {
    if (!draft || draftErrors.length || saving) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const row = {
      event_type: draft.event,
      product_id: draft.productId || null,
      body: draft.body.trim(),
      active: draft.active,
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    }
    const { error } = draft.id
      ? await supabase.from('sms_templates').update(row).eq('id', draft.id)
      : await supabase.from('sms_templates').insert(row)
    setSaving(false)
    if (error) {
      showToast('error', /duplicate|unique/i.test(error.message)
        ? 'A template for that notification type and product already exists.'
        : `Could not save the template: ${error.message}`)
      return
    }
    invalidateSmsTemplateCache()
    showToast('success', draft.id ? 'Template updated.' : 'Template saved — it now governs the matching notifications.')
    setDraft(null)
    void load()
  }

  const toggleActive = async (t: SmsTemplateRow) => {
    const { error } = await supabase.from('sms_templates')
      .update({ active: !t.active, updated_at: new Date().toISOString() })
      .eq('id', t.id)
    if (error) { showToast('error', `Could not update: ${error.message}`); return }
    invalidateSmsTemplateCache()
    setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, active: !t.active } : x))
  }

  const remove = async (t: SmsTemplateRow) => {
    if (!window.confirm(`Delete the ${smsTemplateEventDef(t.event_type).label} template for ${productName(t.product_id)}?\n\nThe built-in wording will be used instead.`)) return
    const { error } = await supabase.from('sms_templates').delete().eq('id', t.id)
    if (error) { showToast('error', `Could not delete: ${error.message}`); return }
    invalidateSmsTemplateCache()
    setTemplates(prev => prev.filter(x => x.id !== t.id))
    showToast('success', 'Template deleted — the standard wording is back in effect.')
  }

  /** Sends the live preview to ONE staff number — the check "what does
   *  the client actually see" without touching any client. */
  const sendTest = async () => {
    if (!draft || !testPhone.trim() || testSending) return
    setTestSending(true)
    const r = await sendSms(testPhone.trim(), preview, { event: 'system', ref: `tpltest:${draft.event}` })
    setTestSending(false)
    if (r.success) showToast('success', `Test SMS sent to ${testPhone.trim()}.`)
    else showToast('error', `Test SMS failed: ${r.error ?? 'gateway error'}`)
  }

  const sorted = useMemo(() => {
    const order = new Map(SMS_TEMPLATE_EVENTS.map((d, i) => [d.event, i]))
    return [...templates].sort((a, b) =>
      (order.get(a.event_type) ?? 99) - (order.get(b.event_type) ?? 99)
      || String(a.product_id ?? '').localeCompare(String(b.product_id ?? '')))
  }, [templates])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sorted.filter(t =>
      (!eventFilter || t.event_type === eventFilter)
      && (!statusFilter || (statusFilter === 'active' ? t.active : !t.active))
      && (!q
        || t.body.toLowerCase().includes(q)
        || (smsTemplateEventDef(t.event_type)?.label ?? '').toLowerCase().includes(q)
        || productName(t.product_id).toLowerCase().includes(q)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, search, eventFilter, statusFilter, products])

  return (
    <div>
      <div className="info-banner info-banner-info" style={{ marginBottom: 14, fontSize: 12.5 }}>
        These templates control the automatic SMS sent to clients — registration confirmations, payment
        receipts, reminders, claim and ticket updates. Where no template exists, the standard wording
        sends exactly as before. A product-specific template wins over its "All products" default.
        Write <code>{'{placeholders}'}</code> from the list — anything else is sent literally.
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Notification Templates ({templates.length})</span>
          {canWrite && !draft && (
            <button className="btn btn-primary btn-sm" onClick={startAdd}>+ Add Template</button>
          )}
        </div>

        {loading ? (
          <div className="empty-state">Loading templates…</div>
        ) : loadError ? (
          <div className="info-banner info-banner-warning" style={{ fontSize: 12.5 }}>{loadError}</div>
        ) : sorted.length === 0 ? (
          <div className="empty-state">
            No templates yet — every notification uses the standard wording. Add one to customise a message.
          </div>
        ) : (
          <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <input
              className="form-control" style={{ maxWidth: 260 }}
              placeholder="Search text, type or product…"
              value={search} onChange={e => setSearch(e.target.value)}
            />
            <select className="form-control" style={{ maxWidth: 240 }} value={eventFilter} onChange={e => setEventFilter(e.target.value)}>
              <option value="">All notification types</option>
              {SMS_TEMPLATE_EVENTS.map(d => <option key={d.event} value={d.event}>{d.label}</option>)}
            </select>
            <select className="form-control" style={{ maxWidth: 130 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="off">Off</option>
            </select>
            {(search || eventFilter || statusFilter) && (
              <button className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setEventFilter(''); setStatusFilter('') }}>Clear</button>
            )}
          </div>
          {filtered.length === 0 ? (
            <div className="empty-state">No templates match that filter.</div>
          ) : (
          <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr><th>Notification</th><th>Product</th><th>Message</th><th>Status</th><th style={{ width: 230 }}></th></tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.id} style={t.active ? undefined : { opacity: 0.55 }}>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{smsTemplateEventDef(t.event_type)?.label ?? t.event_type}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{productName(t.product_id)}</td>
                    <td style={{ maxWidth: 340, fontSize: 12.5 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.body}</span>
                      {t.updated_at && <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>edited {formatDate(t.updated_at)}</span>}
                    </td>
                    <td><span className={`pill pill-${t.active ? 'active' : 'lapsed'}`}>{t.active ? 'active' : 'off'}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canWrite && (
                        <>
                          <button className="btn btn-ghost btn-sm" onClick={() => startEdit(t)}>Edit</button>
                          <button
                            className="btn btn-ghost btn-sm" title="Start a new template from this wording — change the product and save"
                            onClick={() => setDraft({ id: null, event: t.event_type, productId: t.product_id ?? '', body: t.body, active: true })}
                          >Copy</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(t)}>{t.active ? 'Turn off' : 'Turn on'}</button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => void remove(t)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
          </>
        )}
      </div>

      {/* ── Editor ── */}
      {draft && def && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <span className="card-title">{draft.id ? 'Edit Template' : 'New Template'}</span>
          </div>

          <div className="form-row" style={{ marginBottom: 12 }}>
            <div className="form-group">
              <label>Notification type *</label>
              <select
                className="form-control"
                value={draft.event}
                disabled={!!draft.id}
                onChange={e => {
                  const event = e.target.value as SmsTemplateEvent
                  const d = smsTemplateEventDef(event)
                  setDraft(prev => prev && { ...prev, event, body: prev.body.trim() ? prev.body : d.defaultBody })
                }}
              >
                {SMS_TEMPLATE_EVENTS.map(d => <option key={d.event} value={d.event}>{d.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Product *</label>
              <select
                className="form-control"
                value={draft.productId}
                disabled={!!draft.id}
                onChange={e => setDraft({ ...draft, productId: e.target.value })}
              >
                <option value="">All products (default for this type)</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 8 }}>
            <label>Message * <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 11.5 }}>({previewLen} chars — sends as {segments} SMS segment{segments === 1 ? '' : 's'}; the gateway bills per segment)</span></label>
            <textarea
              ref={bodyRef}
              className={`form-control${unknown.length || bodyTooLong ? ' field-invalid' : ''}`}
              rows={3}
              value={draft.body}
              maxLength={1200}
              placeholder={def.defaultBody}
              onChange={e => setDraft({ ...draft, body: e.target.value })}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>
              Click to insert a placeholder (replaced per message):
              <button
                type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 8, padding: '1px 8px', fontSize: 11 }}
                onClick={() => setDraft({ ...draft, body: def.defaultBody })}
                title="Discard your wording and reload the standard text"
              >Reset to standard wording</button>
            </span>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {def.vars.map(v => (
                <button
                  key={v.name} type="button"
                  className="btn btn-secondary btn-sm"
                  title={v.hint}
                  onClick={() => insertPlaceholder(v.name)}
                  style={{ fontFamily: 'monospace' }}
                >{`{${v.name}}`}</button>
              ))}
            </div>
          </div>

          {draft.body.trim() && (
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Preview with sample data:</span>
              <div className="info-banner info-banner-info" style={{ fontSize: 13, fontFamily: 'monospace', padding: '9px 12px' }}>
                {preview || <em>—</em>}
              </div>
            </div>
          )}

          {draft.body.trim() && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
              <input
                className="form-control" style={{ maxWidth: 210 }}
                placeholder="Test number, e.g. 0771234567"
                value={testPhone} onChange={e => setTestPhone(e.target.value)}
              />
              <button className="btn btn-secondary btn-sm" disabled={testSending || !testPhone.trim() || draftErrors.length > 0} onClick={() => void sendTest()}>
                {testSending ? 'Sending…' : 'Send test SMS'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Sends the preview to that number only — nothing goes to clients.</span>
            </div>
          )}

          {draftErrors.length > 0 && (
            <div className="form-error" role="alert" style={{ marginBottom: 12 }}>
              {draftErrors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} />
            Active — use this template for matching notifications
          </label>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving || draftErrors.length > 0 || !canWrite}>
              {saving ? 'Saving…' : 'Save Template'}
            </button>
            <button className="btn btn-secondary" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
          </div>
          {!canWrite && (
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>You don't have permission to change SMS templates.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function SmsTemplates(props: Props) {
  return (
    <div className="panel">
      <SmsTemplatesPanel {...props} />
    </div>
  )
}
