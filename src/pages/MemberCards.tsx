import { useEffect, useMemo, useRef, useState } from 'react'
import type { Client, Policy, PolicyCard } from '../types'
import { db } from '../lib/db'
import { useAuth } from '../contexts/AuthContext'
import { searchMembers, policyMembers, parseMemberNumber } from '../lib/memberNumbers'
import type { PolicyMember } from '../lib/memberNumbers'
import { categoryIssuesMemberCards } from '../lib/productUtils'
import { exportCard, printCard, CARD_EXPORT_FORMATS } from '../lib/cardExport'
import type { CardExportFormat } from '../lib/cardExport'
import MemberCard, { CARD_WIDTH_PX, CARD_HEIGHT_PX } from '../components/ui/MemberCard'
import IssueCardModal from '../components/modals/IssueCardModal'
import RfidScanModal from '../components/modals/RfidScanModal'

/**
 * Membership IDs.
 *
 * Everyone on a policy — the policyholder and each dependant — has a member
 * number (see lib/memberNumbers.ts), and this is where that becomes a card
 * they can carry: previewed on screen, exported to send or print, and
 * optionally backed by an RFID tag so a reader at a desk resolves the card
 * to the household in one tap.
 *
 * Dependants are never listed on their own here. Every row names the
 * policyholder carrying them, because a dependant's cover only exists
 * through that person.
 */

interface Props {
  showToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
}

/** How wide the preview is allowed to be on screen; the card scales to it. */
const PREVIEW_WIDTH = 420

export default function MemberCards({ showToast }: Props) {
  const { user, hasPermission } = useAuth()
  const [policies, setPolicies] = useState<Policy[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [cards, setCards] = useState<PolicyCard[]>([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<PolicyMember | null>(null)
  const [face, setFace] = useState<'front' | 'back'>('front')
  const [format, setFormat] = useState<CardExportFormat>('png')
  const [exporting, setExporting] = useState(false)
  const [issueOpen, setIssueOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)

  const frontRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLDivElement>(null)

  const canIssue = hasPermission('cards.issue')

  const load = () => {
    Promise.all([db.policies.list(), db.clients.list(), db.policyCards.list()])
      .then(([polRes, cliRes, cardRes]) => {
        if (polRes.error || cliRes.error || cardRes.error) showToast('error', 'Failed to load membership data.')
        if (polRes.data) setPolicies(polRes.data)
        if (cliRes.data) setClients(cliRes.data)
        setCards(cardRes.data)
        setLoading(false)
      })
      .catch(() => { showToast('error', 'Failed to load membership data.'); setLoading(false) })
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  const cardByMember = useMemo(
    () => new Map(cards.map(c => [c.memberNumber, c])),
    [cards],
  )

  // Two rules decide who can hold a card.
  //
  // Only live policies: a cancelled or expired policy's card is a problem
  // waiting to happen at a service desk.
  //
  // And only cover that follows a person. Agriculture insures a crop and a
  // barn, motor a vehicle, property a building -- there is nobody to hand a
  // card to, and issuing one would imply the cover travels with a person
  // when it does not. Cards are for the funeral, hospital cash and combo
  // plans, where the policyholder and each dependant have to be
  // identifiable in their own right.
  const cardablePolicies = useMemo(
    () => policies.filter(p =>
      (p.status === 'active' || p.status === 'waiting_period') &&
      categoryIssuesMemberCards(p.productCategory)),
    [policies],
  )
  // The browse view is organised by policyholder: each row is the person
  // carrying the cover, and clicking expands to show the dependants on
  // their policy. Searching drops the grouping — a specific person can be
  // found directly whether they hold the policy or ride on it.
  const policyGroups = useMemo(
    () => cardablePolicies
      .map(policy => {
        const members = policyMembers(policy)
        const holder = members.find(m => m.role === 'holder')
        return holder
          ? { policy, holder, dependants: members.filter(m => m.role !== 'holder') }
          : null
      })
      .filter((g): g is { policy: Policy; holder: PolicyMember; dependants: PolicyMember[] } => !!g),
    [cardablePolicies],
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpand = (policyId: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(policyId)) next.delete(policyId); else next.add(policyId)
    return next
  })

  const results = useMemo(
    () => (search.trim().length >= 2 ? searchMembers(cardablePolicies, search, 40) : []),
    [cardablePolicies, search],
  )

  const selectedCard = selected ? cardByMember.get(selected.memberNumber) : undefined

  /** Fills in the holder's ID/DOB, which live on the client record rather
   *  than the policy the member was built from. */
  const enrich = (member: PolicyMember): PolicyMember => {
    if (member.role !== 'holder') return member
    const client = clients.find(c => c.id === member.holderClientId)
    return client ? { ...member, dob: client.dob, nationalId: client.nationalId } : member
  }

  const handleExport = async () => {
    if (!selected) return
    const nodes = [frontRef.current, backRef.current].filter((n): n is HTMLDivElement => !!n)
    if (nodes.length === 0) return
    setExporting(true)
    try {
      await exportCard(nodes, format, `${selected.memberNumber}-card`)
      showToast('success', `Card exported as ${format.toUpperCase()}.`)
    } catch (e) {
      showToast('error', `Could not export the card: ${e}`)
    }
    setExporting(false)
  }

  const handlePrint = async () => {
    if (!selected) return
    const nodes = [frontRef.current, backRef.current].filter((n): n is HTMLDivElement => !!n)
    if (nodes.length === 0) return
    setExporting(true)
    try {
      await printCard(nodes)
    } catch (e) {
      showToast('error', `Could not open the card for printing: ${e}`)
    }
    setExporting(false)
  }

  const handleScanResult = (tag: string) => {
    const card = cards.find(c => c.rfidTag === tag.trim())
    if (!card) {
      showToast('warning', `No member is registered to tag ${tag}. Issue a card and assign this tag to it.`)
      return
    }
    if (card.status !== 'active') {
      showToast('error', `${card.memberName} (${card.memberNumber}) — this card is ${card.status}. Do not accept it.`)
    } else {
      showToast('success', `${card.memberName} · ${card.memberNumber} — carried by ${card.holderName}.`)
    }
    const parsed = parseMemberNumber(card.memberNumber)
    const policy = policies.find(p => p.policyNumber === parsed?.policyNumber)
    if (policy) {
      const member = policyMembers(policy).find(m => m.memberNumber === card.memberNumber)
      if (member) { setSelected(enrich(member)); setSearch(card.memberNumber) }
    }
  }

  if (loading) return <div className="panel"><div className="empty-state">Loading membership IDs…</div></div>

  const previewScale = PREVIEW_WIDTH / CARD_WIDTH_PX

  return (
    <div className="panel">
      <div className="member-card-toolbar">
        <input
          className="form-control"
          placeholder="Search by member number, name, national ID, or policy number…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setScanOpen(true)}>
          📡 Scan RFID Card
        </button>
      </div>

      <div className="member-card-layout">
        <div className="member-card-list-pane">
          <div className="member-card-list-title">
            {search.trim().length >= 2
              ? `${results.length} match${results.length === 1 ? '' : 'es'}`
              : `${policyGroups.length} policyholder${policyGroups.length === 1 ? '' : 's'}`}
          </div>
          {(() => {
            const memberRow = (member: PolicyMember, nested = false) => {
              const card = cardByMember.get(member.memberNumber)
              return (
                <li key={member.memberNumber} style={nested ? { paddingLeft: 22 } : undefined}>
                  <button
                    type="button"
                    className={`member-card-row${selected?.memberNumber === member.memberNumber ? ' active' : ''}`}
                    onClick={() => setSelected(enrich(member))}
                  >
                    <span className="member-card-row-main">
                      <span className="member-card-row-name">{member.name || '(unnamed)'}</span>
                      <span className="mono member-card-row-number">{member.memberNumber}</span>
                    </span>
                    <span className="member-card-row-sub">
                      {member.role === 'holder'
                        ? 'Policyholder'
                        : `${member.relationship || 'Dependant'} · carried by ${member.holderName}`}
                    </span>
                    <span className="member-card-row-tags">
                      <span className="pill pill-muted">{member.planName}</span>
                      {card
                        ? <span className={`pill ${card.status === 'active' ? 'pill-active' : 'pill-warning'}`}>{card.rfidTag ? `RFID ${card.rfidTag}` : 'Card issued'}</span>
                        : <span className="pill pill-muted">No card</span>}
                    </span>
                  </button>
                </li>
              )
            }

            // Search: flat list of anyone matching — holder or dependant.
            if (search.trim().length >= 2) {
              return results.length === 0 ? (
                <div className="empty-state" style={{ padding: '2rem 1rem' }}>Nobody matches that.</div>
              ) : (
                <ul className="member-card-list">{results.map(m => memberRow(m))}</ul>
              )
            }

            // Browse: policyholders first, dependants under their holder.
            return policyGroups.length === 0 ? (
              <div className="empty-state" style={{ padding: '2rem 1rem' }}>No live policies that carry member cards.</div>
            ) : (
              <ul className="member-card-list">
                {policyGroups.map(({ policy, holder, dependants }) => {
                  const open = expanded.has(policy.id)
                  return (
                    <li key={policy.id}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <button
                            type="button"
                            className={`member-card-row${selected?.memberNumber === holder.memberNumber ? ' active' : ''}`}
                            style={{ width: '100%' }}
                            onClick={() => setSelected(enrich(holder))}
                          >
                            <span className="member-card-row-main">
                              <span className="member-card-row-name">{holder.name || '(unnamed)'}</span>
                              <span className="mono member-card-row-number">{holder.memberNumber}</span>
                            </span>
                            <span className="member-card-row-sub">
                              Policyholder{dependants.length > 0 ? ` · ${dependants.length} dependant${dependants.length === 1 ? '' : 's'}` : ''}
                            </span>
                            <span className="member-card-row-tags">
                              <span className="pill pill-muted">{holder.planName}</span>
                              {cardByMember.get(holder.memberNumber)
                                ? <span className={`pill ${cardByMember.get(holder.memberNumber)!.status === 'active' ? 'pill-active' : 'pill-warning'}`}>{cardByMember.get(holder.memberNumber)!.rfidTag ? `RFID ${cardByMember.get(holder.memberNumber)!.rfidTag}` : 'Card issued'}</span>
                                : <span className="pill pill-muted">No card</span>}
                            </span>
                          </button>
                        </div>
                        {dependants.length > 0 && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{ padding: '4px 8px', fontSize: 15 }}
                            title={open ? 'Hide dependants' : 'Show dependants'}
                            onClick={() => toggleExpand(policy.id)}
                          >{open ? '▾' : '▸'}</button>
                        )}
                      </div>
                      {open && (
                        <ul className="member-card-list" style={{ marginTop: 2 }}>
                          {dependants.map(d => memberRow(d, true))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            )
          })()}
        </div>

        <div className="member-card-preview-pane">
          {!selected ? (
            <div className="empty-state" style={{ padding: '3rem 1rem' }}>
              Pick a member to see their card.
            </div>
          ) : (
            <>
              <div className="member-card-stage">
                {/* Both faces stay mounted AND laid out, because the export
                    rasterises whichever one is not currently on screen too.
                    The inactive face is moved off to the side rather than
                    display:none'd -- a hidden element has no layout box, so
                    the card's gradients resolve against zero width and
                    html2canvas throws on the non-finite colour stops. */}
                <div style={{ position: 'relative', width: PREVIEW_WIDTH, height: previewScale * CARD_HEIGHT_PX }}>
                  <div className={face === 'front' ? undefined : 'member-card-face-offstage'}>
                    <MemberCard ref={frontRef} member={selected} card={selectedCard} face="front" scale={previewScale} />
                  </div>
                  <div className={face === 'back' ? undefined : 'member-card-face-offstage'}>
                    <MemberCard ref={backRef} member={selected} card={selectedCard} face="back" scale={previewScale} />
                  </div>
                </div>
              </div>

              <div className="member-card-actions">
                <div className="bubble-toggle">
                  <button type="button" className={`bubble-toggle-btn${face === 'front' ? ' active' : ''}`} onClick={() => setFace('front')}>Front</button>
                  <button type="button" className={`bubble-toggle-btn${face === 'back' ? ' active' : ''}`} onClick={() => setFace('back')}>Back</button>
                </div>
              </div>

              <div className="member-card-meta">
                <div className="sh-info-row"><span>Member</span><strong>{selected.name || '—'}</strong></div>
                <div className="sh-info-row"><span>Member Number</span><strong className="mono">{selected.memberNumber}</strong></div>
                <div className="sh-info-row"><span>Policyholder</span><strong>{selected.holderName}</strong></div>
                <div className="sh-info-row"><span>Policy</span><strong className="mono">{selected.policyNumber}</strong></div>
                <div className="sh-info-row"><span>Plan</span><strong>{selected.planName}</strong></div>
                <div className="sh-info-row">
                  <span>Card</span>
                  <strong>{selectedCard ? `${selectedCard.status}${selectedCard.rfidTag ? ` · RFID ${selectedCard.rfidTag}` : ' · no tag'}` : 'Not issued'}</strong>
                </div>
              </div>

              <div className="member-card-export">
                <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Export
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select className="form-control" style={{ width: 120 }} value={format} onChange={e => setFormat(e.target.value as CardExportFormat)}>
                    {CARD_EXPORT_FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
                  </select>
                  <button type="button" className="btn btn-primary btn-sm" onClick={handleExport} disabled={exporting}>
                    {exporting ? 'Exporting…' : '⬇ Download'}
                  </button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={handlePrint} disabled={exporting} title="Opens a true-size, print-ready PDF in a new tab -- print it to a card printer the same as any other printer.">
                    🖨 Print
                  </button>
                  {canIssue && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => setIssueOpen(true)}>
                      {selectedCard ? '⚙ Manage Card & RFID' : '＋ Issue Card'}
                    </button>
                  )}
                </div>
                <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
                  PDF exports at true card size (85.6 × 54 mm), one page per face — ready for a card printer.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {issueOpen && selected && (
        <IssueCardModal
          member={selected}
          existing={selectedCard}
          issuedBy={user?.id}
          onClose={() => setIssueOpen(false)}
          onSaved={card => {
            setCards(prev => {
              const rest = prev.filter(c => c.memberNumber !== card.memberNumber)
              return [card, ...rest]
            })
            setIssueOpen(false)
          }}
          showToast={showToast}
        />
      )}

      {scanOpen && (
        <RfidScanModal
          onClose={() => setScanOpen(false)}
          onScanned={tag => { setScanOpen(false); handleScanResult(tag) }}
        />
      )}
    </div>
  )
}
