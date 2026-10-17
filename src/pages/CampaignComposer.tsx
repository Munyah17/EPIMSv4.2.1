import { useState, useEffect } from 'react'
import type { ToastMessage, MarketingContact, MarketingTemplate, MarketingCampaign, MarketingChannel } from '../types'
import type { ActivePanel } from '../App'
import { db } from '../lib/db'
import { formatDate } from '../lib/dateUtils'
import { sendEmail } from '../lib/mailService'
import { useAuth } from '../contexts/AuthContext'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
  setActivePanel: (panel: ActivePanel) => void
}

const MAX_SMS_CHARS = 5000

export default function CampaignComposer({ showToast }: Props) {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'compose' | 'history' | 'templates'>('compose')
  const [contacts, setContacts] = useState<MarketingContact[]>([])
  const [templates, setTemplates] = useState<MarketingTemplate[]>([])
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([])
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [showTemplateModal, setShowTemplateModal] = useState(false)

  // Campaign form state
  const [campaignName, setCampaignName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [channel, setChannel] = useState<MarketingChannel>('sms')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    db.marketingContacts.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load contacts.')
      else if (data) setContacts(data.filter(c => !c.optedOut))
    })
    db.marketingTemplates.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load templates.')
      else if (data) setTemplates(data.filter(t => t.active))
    })
    db.marketingCampaigns.list().then(({ data, error }) => {
      if (error) showToast('error', 'Failed to load campaigns.')
      else if (data) setCampaigns(data)
    })
  }, [showToast])

  const visibleContacts = contacts.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.phone.includes(search)
  )

  const eligibleContacts = visibleContacts.filter(c => {
    if (channel === 'sms') return c.phone
    if (channel === 'email') return c.email
    if (channel === 'both') return c.phone || c.email
    return true
  })

  const toggleContact = (id: string) => {
    setSelectedContacts(prev => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id); else s.add(id)
      return s
    })
  }

  const selectAll = () => setSelectedContacts(new Set(eligibleContacts.map(c => c.id)))
  const deselectAll = () => setSelectedContacts(new Set())

  const selectedContactObjs = contacts.filter(c => selectedContacts.has(c.id))
  const smsSegments = Math.ceil(description.length / MAX_SMS_CHARS) || 1
  const estimatedSmsCost = selectedContactObjs.filter(c => c.phone).length * smsSegments * 0.05 // $0.05 per segment

  const handleSend = async () => {
    if (!campaignName.trim() || !description.trim()) {
      showToast('warning', 'Campaign name and message are required.')
      return
    }
    if (selectedContactObjs.length === 0) {
      showToast('warning', 'Please select at least one contact.')
      return
    }

    const confirmMsg = `Send ${channel === 'both' ? 'SMS and Email' : channel.toUpperCase()} to ${selectedContactObjs.length} contact(s)?`
    if (!window.confirm(confirmMsg)) return

    setSending(true)
    try {
      // Create campaign
      const campaign = await db.marketingCampaigns.create({
        name: campaignName.trim(),
        title: title.trim() || undefined,
        description: description.trim(),
        channel,
        recipientCount: selectedContactObjs.length,
        smsSegmentCount: smsSegments,
        estimatedSmsCost,
        status: 'sending',
      })

      if (!campaign.data) {
        showToast('error', 'Failed to create campaign.')
        setSending(false)
        return
      }

      // Create recipients
      const recipients = selectedContactObjs.map(c => ({
        campaignId: campaign.data.id,
        contactId: c.id,
        phone: c.phone || undefined,
        email: c.email || undefined,
      }))

      await db.campaignRecipients.create(recipients)

      // Send messages (simplified - will be enhanced with background processing)
      const { sendBulkSms } = await import('../lib/smsService')
      
      // SMS sending
      const smsContacts = selectedContactObjs.filter(c => c.phone)
      if (smsContacts.length > 0 && (channel === 'sms' || channel === 'both')) {
        const numbers = smsContacts.map(c => c.phone)
        const personalizedMessages = smsContacts.map(c => 
          description.replace(/{name}/g, c.name.split(' ')[0])
        )
        
        for (let i = 0; i < numbers.length; i++) {
          await sendBulkSms([numbers[i]], personalizedMessages[i])
        }
      }

      // Email sending
      const emailContacts = selectedContactObjs.filter(c => c.email)
      if (emailContacts.length > 0 && (channel === 'email' || channel === 'both')) {
        for (const contact of emailContacts) {
          const personalizedBody = description.replace(/{name}/g, contact.name.split(' ')[0])
          const emailSubject = title || campaignName
          await sendEmail({
            to: contact.email!,
            subject: emailSubject,
            body: personalizedBody,
          })
        }
      }

      // Update campaign status
      await db.marketingCampaigns.update(campaign.data.id, {
        status: 'completed',
        sentAt: new Date().toISOString(),
      })

      // Refresh campaigns
      const { data: updatedCampaigns } = await db.marketingCampaigns.list()
      if (updatedCampaigns) setCampaigns(updatedCampaigns)

      showToast('success', `Campaign sent to ${selectedContactObjs.length} contact(s).`)
      
      // Reset form
      setCampaignName('')
      setTitle('')
      setDescription('')
      setSelectedContacts(new Set())
    } catch (e) {
      showToast('error', 'Failed to send campaign.')
      console.error(e)
    } finally {
      setSending(false)
    }
  }

  const handleUseTemplate = (template: MarketingTemplate) => {
    setTitle(template.title || '')
    setDescription(template.description)
  }

  return (
    <div className="panel">
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button className={`tab${tab === 'compose' ? ' active' : ''}`} onClick={() => setTab('compose')}>
          Compose Campaign
        </button>
        <button className={`tab${tab === 'templates' ? ' active' : ''}`} onClick={() => setTab('templates')}>
          Templates ({templates.length})
        </button>
        <button className={`tab${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>
          Campaign History ({campaigns.length})
        </button>
      </div>

      {/* ── COMPOSE TAB ── */}
      {tab === 'compose' && (
        <div className="mass-sms-layout">
          {/* Left: Contact list */}
          <div className="mass-sms-left">
            <div className="card">
              <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span className="card-title">Recipients ({selectedContacts.size}/{eligibleContacts.length})</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-ghost btn-sm" onClick={selectAll}>All</button>
                  <button className="btn btn-ghost btn-sm" onClick={deselectAll}>None</button>
                </div>
              </div>
              <div className="form-row" style={{ marginBottom: 10, display: 'flex', gap: '10px' }}>
                <select 
                  className="form-control" 
                  value={channel} 
                  onChange={e => setChannel(e.target.value as MarketingChannel)}
                  style={{ 
                    width: '140px',
                    flexShrink: 0,
                    backgroundColor: '#ffffff', 
                    color: '#000000',
                    minHeight: '40px',
                    padding: '10px 12px',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px'
                  }}
                >
                  <option value="sms">SMS Only</option>
                  <option value="email">Email Only</option>
                  <option value="both">SMS + Email</option>
                </select>
                <input
                  className="search-input"
                  placeholder="Search contacts…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="mass-sms-client-list">
                {eligibleContacts.map(c => (
                  <label key={c.id} className="mass-sms-client-row">
                    <input
                      type="checkbox"
                      checked={selectedContacts.has(c.id)}
                      onChange={() => toggleContact(c.id)}
                    />
                    <div className="mass-sms-client-info">
                      <span className="mass-sms-client-name">{c.name}</span>
                      <span className="mass-sms-client-phone">{c.phone}</span>
                      {c.email && <span className="mass-sms-client-phone">{c.email}</span>}
                    </div>
                  </label>
                ))}
                {eligibleContacts.length === 0 && (
                  <div className="empty-state" style={{ padding: '20px 0' }}>
                    {visibleContacts.length === 0 ? 'No contacts match search.' : 'No eligible contacts for selected channel.'}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: Composer */}
          <div className="mass-sms-right">
            <div className="card">
              <div className="card-header">
                <span className="card-title">Campaign Details</span>
              </div>

              <div style={{ padding: '16px' }}>

              <div className="form-group" style={{ marginBottom: 16 }}>
                <label>Campaign Name *</label>
                <input
                  className="form-control"
                  value={campaignName}
                  onChange={e => setCampaignName(e.target.value)}
                  placeholder="e.g., October Promotion 2026"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 16 }}>
                <label>Title (optional)</label>
                <input
                  className="form-control"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g., Special Offer for Farmers"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 16 }}>
                <label>Message Description *</label>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                  Use {`{name}`} to personalize with recipient's first name
                </div>
                <textarea
                  className="form-control"
                  rows={8}
                  placeholder="Dear {name}, we have a special offer for you..."
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
                <div style={{ fontSize: 11, color: description.length > MAX_SMS_CHARS ? 'var(--danger)' : 'var(--muted)', marginTop: 4 }}>
                  {description.length}/{MAX_SMS_CHARS} chars
                </div>
              </div>

              <div className="mass-sms-quick-templates" style={{ marginBottom: 16 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, display: 'block' }}>Quick templates:</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {templates.slice(0, 4).map((t) => (
                    <button key={t.id} className="btn btn-secondary btn-sm" onClick={() => handleUseTemplate(t)}>
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>

              </div>

              <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <div className="mass-sms-summary">
                  <span>{selectedContacts.size} recipient{selectedContacts.size !== 1 ? 's' : ''}</span>
                  <span>Channel: {channel.toUpperCase()}</span>
                  {channel === 'sms' || channel === 'both' ? (
                    <span>Est. SMS Cost: ${estimatedSmsCost.toFixed(2)}</span>
                  ) : null}
                </div>
                <button
                  className="btn btn-primary btn-full"
                  style={{ marginTop: 10 }}
                  onClick={handleSend}
                  disabled={sending || !hasPermission('communications.send_sms')}
                >
                  {sending ? '📨 Sending…' : `🚀 Send ${channel === 'both' ? 'Campaign' : channel.toUpperCase()}`}
                </button>
                {!hasPermission('communications.send_sms') && (
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>You don't have permission to send campaigns.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── TEMPLATES TAB ── */}
      {tab === 'templates' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Message Templates</span>
            <button className="btn btn-primary btn-sm" onClick={() => setShowTemplateModal(true)}>+ Create Template</button>
          </div>
          <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Created By</th>
                  <th>Description Preview</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates.map(t => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong></td>
                    <td>{t.title || '—'}</td>
                    <td><span className="pill pill-active">{t.category || 'general'}</span></td>
                    <td>{t.createdByName || '—'}</td>
                    <td style={{ maxWidth: 300 }}>{t.description.slice(0, 100)}{t.description.length > 100 ? '...' : ''}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => { handleUseTemplate(t); setTab('compose'); }}>
                        Use
                      </button>
                    </td>
                  </tr>
                ))}
                {templates.length === 0 && (
                  <tr><td colSpan={6} className="td-empty">No templates found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {tab === 'history' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Campaign History</span>
          </div>
          <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Channel</th>
                  <th>Recipients</th>
                  <th>Status</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong></td>
                    <td><span className="pill pill-active">{c.channel.toUpperCase()}</span></td>
                    <td>{c.recipientCount}</td>
                    <td>
                      <span className={`pill pill-${c.status === 'completed' ? 'active' : c.status === 'sending' ? 'pending' : 'lapsed'}`}>
                        {c.status}
                      </span>
                    </td>
                    <td>{c.sentAt ? formatDate(c.sentAt) : '—'}</td>
                  </tr>
                ))}
                {campaigns.length === 0 && (
                  <tr><td colSpan={5} className="td-empty">No campaigns sent yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showTemplateModal && (
        <TemplateModal
          onClose={() => setShowTemplateModal(false)}
          onSave={async (template) => {
            const { data, error } = await db.marketingTemplates.create(template)
            if (error || !data) {
              showToast('error', 'Failed to create template.')
              return
            }
            const { data: updated } = await db.marketingTemplates.list()
            if (updated) setTemplates(updated.filter(t => t.active))
            setShowTemplateModal(false)
            showToast('success', 'Template created successfully.')
          }}
          showToast={showToast}
        />
      )}
    </div>
  )
}

// ── TEMPLATE MODAL ───────────────────────────────────────────────────

interface TemplateModalProps {
  onClose: () => void
  onSave: (template: Omit<MarketingTemplate, 'id' | 'createdByName' | 'createdAt' | 'updatedAt'>) => void
  showToast: (type: ToastMessage['type'], message: string) => void
}

function TemplateModal({ onClose, onSave, showToast }: TemplateModalProps) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !description.trim()) {
      showToast('warning', 'Name and description are required.')
      return
    }
    await onSave({
      name: name.trim(),
      title: title.trim() || undefined,
      description: description.trim(),
      category: category.trim() || undefined,
      active: true,
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <div className="modal-header">
          <h3>Create Template</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Name *</label>
            <input className="form-control" value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Title (optional)</label>
            <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Category</label>
            <input className="form-control" value={category} onChange={e => setCategory(e.target.value)} placeholder="e.g., welcome, promotion, reminder" />
          </div>
          <div className="form-group">
            <label>Description *</label>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
              Use {`{name}`} to personalize with recipient's first name
            </div>
            <textarea className="form-control" rows={6} value={description} onChange={e => setDescription(e.target.value)} required />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create Template</button>
          </div>
        </form>
      </div>
    </div>
  )
}
