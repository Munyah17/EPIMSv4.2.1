import { useState, useEffect } from 'react'
import type { ToastMessage, MarketingContact } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { isZwPhone, PHONE_HINT } from '../lib/validation'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

export default function MarketingContacts({ showToast }: Props) {
  const [contacts, setContacts] = useState<MarketingContact[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [interestFilter, setInterestFilter] = useState<string>('all')
  const [optedOutFilter, setOptedOutFilter] = useState<'all' | 'active' | 'opted_out'>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingContact, setEditingContact] = useState<MarketingContact | null>(null)

  useEffect(() => {
    db.marketingContacts.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load marketing contacts.')
      else if (data) setContacts(data)
      setLoading(false)
    }).catch(() => { showToast('error', 'Failed to load marketing contacts.'); setLoading(false) })
  }, [showToast])

  const filtered = contacts.filter(c => {
    const matchSearch = c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search) ||
      (c.email && c.email.toLowerCase().includes(search.toLowerCase()))
    const matchInterest = interestFilter === 'all' || c.insuranceInterest === interestFilter
    const matchOptOut = optedOutFilter === 'all' ||
      (optedOutFilter === 'active' && !c.optedOut) ||
      (optedOutFilter === 'opted_out' && c.optedOut)
    return matchSearch && matchInterest && matchOptOut
  })

  const interestOptions = ['all', ...new Set(contacts.map(c => c.insuranceInterest).filter(Boolean))]

  const handleAdd = async (contact: Omit<MarketingContact, 'id' | 'createdByName' | 'createdAt' | 'updatedAt' | 'normalizedPhone'>) => {
    const { data, error } = await db.marketingContacts.create(contact)
    if (error || !data) { showToast('error', error ?? 'Failed to add contact.'); return }
    setContacts(prev => [data, ...prev])
    setShowAdd(false)
    showToast('success', `Contact "${data.name}" added.`)
  }

  const handleUpdate = async (updated: Omit<MarketingContact, 'id' | 'createdByName' | 'createdAt' | 'updatedAt' | 'normalizedPhone'>) => {
    const { data, error } = await db.marketingContacts.update(editingContact!.id, updated)
    if (error || !data) { showToast('error', 'Failed to update contact.'); return }
    setContacts(prev => prev.map(c => c.id === data.id ? data : c))
    setEditingContact(null)
    showToast('success', `Contact "${data.name}" updated.`)
  }

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete contact "${name}"?`)) return
    const { error } = await db.marketingContacts.delete(id)
    if (error) { showToast('error', error); return }
    setContacts(prev => prev.filter(c => c.id !== id))
    showToast('success', `Contact "${name}" deleted.`)
  }

  const handleOptOut = async (contact: MarketingContact) => {
    const reason = prompt('Opt-out reason (optional):')
    const { data, error } = await db.marketingContacts.update(contact.id, {
      optedOut: true,
      optedOutAt: new Date().toISOString(),
      optOutReason: reason || undefined,
      optOutChannel: 'sms',
    })
    if (error || !data) { showToast('error', 'Failed to opt out contact.'); return }
    setContacts(prev => prev.map(c => c.id === data.id ? data : c))
    showToast('success', `Contact "${data.name}" opted out of marketing.`)
  }

  const handleOptIn = async (contact: MarketingContact) => {
    const { data, error } = await db.marketingContacts.update(contact.id, {
      optedOut: false,
      optedOutAt: undefined,
      optOutReason: undefined,
      optOutChannel: undefined,
    })
    if (error || !data) { showToast('error', 'Failed to opt in contact.'); return }
    setContacts(prev => prev.map(c => c.id === data.id ? data : c))
    showToast('success', `Contact "${data.name}" opted back in to marketing.`)
  }

  const activeCount = contacts.filter(c => !c.optedOut).length
  const optedOutCount = contacts.filter(c => c.optedOut).length

  const downloadTemplate = () => {
    const template = 'name,phone,email,insurance_interest,source\nJohn Doe,+263 712 345 678,john@example.com,funeral,facebook_ad\nJane Smith,+263 713 456 789,,agriculture,whatsapp\nRobert Mugabe,+263 714 567 890,bob@example.com,health,manual'
    const blob = new Blob([template], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.setAttribute('href', url)
    link.setAttribute('download', 'marketing_contacts_template.csv')
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Search name, phone, email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className="filter-select" value={interestFilter} onChange={e => setInterestFilter(e.target.value)}>
            <option value="all">All Interests</option>
            {interestOptions.filter(i => i !== 'all').map(i => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
          <select className="filter-select" value={optedOutFilter} onChange={e => setOptedOutFilter(e.target.value as any)}>
            <option value="all">All Status ({contacts.length})</option>
            <option value="active">Active ({activeCount})</option>
            <option value="opted_out">Opted Out ({optedOutCount})</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-outline" onClick={() => setShowImport(true)}>
            📥 Import CSV
          </button>
          <button type="button" className="btn btn-outline" onClick={downloadTemplate}>
            📋 Download Template
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
            + Add Contact
          </button>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading marketing contacts…</div>
        ) : (
          <div className="tbl-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Interest</th>
                <th>Source</th>
                <th>Status</th>
                <th>Added</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="td-empty">No contacts found.</td></tr>
              ) : filtered.map(c => (
                <tr key={c.id} style={{ opacity: c.optedOut ? 0.6 : 1 }}>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.phone}</td>
                  <td>{c.email || '—'}</td>
                  <td>{c.insuranceInterest || '—'}</td>
                  <td>{c.source || '—'}</td>
                  <td>
                    {c.optedOut ? (
                      <span className="pill pill-lapsed">Opted Out</span>
                    ) : (
                      <span className="pill pill-active">Active</span>
                    )}
                  </td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingContact(c)}>Edit</button>
                      {c.optedOut ? (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleOptIn(c)}>Opt In</button>
                      ) : (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleOptOut(c)}>Opt Out</button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(c.id, c.name)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {showAdd && (
        <ContactModal
          onClose={() => setShowAdd(false)}
          onSave={handleAdd}
          showToast={showToast}
        />
      )}

      {editingContact && (
        <ContactModal
          contact={editingContact}
          onClose={() => setEditingContact(null)}
          onSave={handleUpdate}
          showToast={showToast}
        />
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImport={(results, errors) => {
            db.marketingContacts.list().then(({ data }) => {
              if (data) setContacts(data)
            })
            showToast(
              results.errors > 0 ? 'warning' : 'success',
              `Imported: ${results.imported} | Duplicates: ${results.duplicates} | Errors: ${results.errors}`
            )
            if (errors.length > 0) {
              console.error('Import errors:', errors)
            }
          }}
          showToast={showToast}
        />
      )}
    </div>
  )
}

// ── CONTACT MODAL ───────────────────────────────────────────────────

interface ContactModalProps {
  contact?: MarketingContact
  onClose: () => void
  onSave: (contact: Omit<MarketingContact, 'id' | 'createdByName' | 'createdAt' | 'updatedAt' | 'normalizedPhone'>) => void
  showToast: (type: ToastMessage['type'], message: string) => void
}

function ContactModal({ contact, onClose, onSave, showToast }: ContactModalProps) {
  const [name, setName] = useState(contact?.name || '')
  const [phone, setPhone] = useState(contact?.phone || '')
  const [email, setEmail] = useState(contact?.email || '')
  const [insuranceInterest, setInsuranceInterest] = useState(contact?.insuranceInterest || '')
  const [source, setSource] = useState(contact?.source || '')
  const [notes, setNotes] = useState(contact?.notes || '')
  const [marketingPermission, setMarketingPermission] = useState(contact?.marketingPermission ?? true)
  const [attempted, setAttempted] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setAttempted(true)
    if (!name.trim() || !phone.trim()) {
      showToast('warning', 'Name and phone are required.')
      return
    }
    if (!isZwPhone(phone)) {
      showToast('warning', `Phone number: ${PHONE_HINT}.`)
      return
    }
    await onSave({
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim() || undefined,
      insuranceInterest: insuranceInterest.trim() || undefined,
      source: source.trim() || undefined,
      notes: notes.trim() || undefined,
      marketingPermission,
      optedOut: contact?.optedOut || false,
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{contact ? 'Edit Contact' : 'Add Contact'}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Name *</label>
            <input className="form-control" value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Phone *</label>
            <input className={`form-control${attempted && phone.trim() && !isZwPhone(phone) ? ' field-invalid' : ''}`} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+263773909307 or 0773909307" required />
            {attempted && phone.trim() && !isZwPhone(phone) && (
              <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>{PHONE_HINT}.</p>
            )}
          </div>
          <div className="form-group">
            <label>Email</label>
            <input className="form-control" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="email@example.com" />
          </div>
          <div className="form-group">
            <label>Insurance Interest</label>
            <input className="form-control" value={insuranceInterest} onChange={e => setInsuranceInterest(e.target.value)} placeholder="e.g., funeral, agriculture, health" />
          </div>
          <div className="form-group">
            <label>Source</label>
            <input className="form-control" value={source} onChange={e => setSource(e.target.value)} placeholder="e.g., facebook_ad, whatsapp, manual" />
          </div>
          <div className="form-group">
            <label>Notes</label>
            <textarea className="form-control" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          <div className="form-group">
            <label>
              <input type="checkbox" checked={marketingPermission} onChange={e => setMarketingPermission(e.target.checked)} />
              Marketing permission
            </label>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{contact ? 'Update' : 'Add'} Contact</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── IMPORT MODAL ─────────────────────────────────────────────────────

interface ImportModalProps {
  onClose: () => void
  onImport: (results: { imported: number; duplicates: number; errors: number }, errors: string[]) => void
  showToast: (type: ToastMessage['type'], message: string) => void
}

function ImportModal({ onClose, onImport, showToast }: ImportModalProps) {
  const [csvText, setCsvText] = useState('')
  const [importing, setImporting] = useState(false)

  const handleImport = async () => {
    if (!csvText.trim()) {
      showToast('warning', 'Please paste CSV data.')
      return
    }

    setImporting(true)
    try {
      const lines = csvText.trim().split('\n').filter(line => line.trim())
      if (lines.length < 2) {
        showToast('warning', 'CSV must have a header row and at least one data row.')
        setImporting(false)
        return
      }

      const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
      
      const contacts = []
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue // Skip empty rows

        const values = line.split(',').map(v => v.trim())
        const contact: any = {}
        
        headers.forEach((header, idx) => {
          const value = values[idx] || ''
          if (header.includes('name')) contact.name = value
          else if (header.includes('phone')) contact.phone = value
          else if (header.includes('email')) contact.email = value || undefined
          else if (header.includes('interest')) contact.insuranceInterest = value || undefined
          else if (header.includes('source')) contact.source = value || undefined
        })

        // Only import if name and phone are present (phone can be normalized later)
        if (contact.name && contact.phone) {
          contacts.push(contact)
        }
      }

      if (contacts.length === 0) {
        showToast('warning', 'No valid contacts found in CSV. Each row must have name and phone.')
        setImporting(false)
        return
      }

      const { results, errors } = await db.marketingContacts.importCSV(contacts)
      onImport(results, errors)
      onClose()
    } catch (e) {
      showToast('error', 'Failed to parse CSV. Check format.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <div className="modal-header">
          <h3>Import Contacts from CSV</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="info-banner info-banner-info" style={{ marginBottom: 16, fontSize: 12 }}>
          CSV format: name, phone, email, insurance_interest, source (header row required)
        </div>
        <textarea
          className="form-control"
          rows={10}
          placeholder="name,phone,email,insurance_interest,source&#10;John Doe,+263 712 345 678,john@example.com,funeral,facebook_ad&#10;Jane Smith,+263 713 456 789,,agriculture,whatsapp"
          value={csvText}
          onChange={e => setCsvText(e.target.value)}
        />
        <div className="modal-footer">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={importing}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleImport} disabled={importing}>
            {importing ? 'Importing…' : 'Import Contacts'}
          </button>
        </div>
      </div>
    </div>
  )
}
