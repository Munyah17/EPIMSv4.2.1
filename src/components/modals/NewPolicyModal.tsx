import { useState, useEffect } from 'react'
import type { Policy, Dependant, Client, Product, AppUser, Group, GroupMember, GroupType, CoverScope } from '../../types'
import { MANUAL_PAYMENT_METHODS } from '../../types'
import { db } from '../../lib/db'
import { useAuth } from '../../contexts/AuthContext'
import PhoneInput from '../ui/PhoneInput'
import DateInput from '../ui/DateInput'
import { premiumPeriodLabel } from '../../lib/productUtils'
import { computeAssignedStartDate } from '../../lib/policyLifecycle'
import { toIsoDate } from '../../lib/dateUtils'
import { nextPolicyNumber } from '../../lib/policyNumbers'
import { POLICY_SOURCES, DEFAULT_POLICY_SOURCE } from '../../lib/policySources'
import { notifyGroupRegistered } from '../../lib/signupNotifications'
import { serverReachable } from '../../lib/notify'
import ValidationSummary, { MissingField, invalidClass, fieldId, isMissing } from '../ui/ValidationSummary'

interface Props {
  onClose: () => void
  onSave: (policy: Policy) => void
  showToast?: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void
  /** Pre-selects and locks this client (e.g. "Assign Policy" from the
   *  Clients page for someone registered with no policy yet) — skips the
   *  New/Existing toggle and search step entirely. */
  initialClient?: Client
}

export default function NewPolicyModal({ onClose, onSave, showToast, initialClient }: Props) {
  const { user } = useAuth()
  // A customer already on file can take out another policy without being
  // re-registered from scratch — that's what "existing" mode is for. It's
  // also how a client ends up holding more than one policy at all.
  const [customerMode, setCustomerMode] = useState<'new' | 'existing'>(initialClient ? 'existing' : 'new')
  const [clientSearch, setClientSearch] = useState('')
  const [existingClientId, setExistingClientId] = useState('')
  const [existingClients, setExistingClients] = useState<Client[]>([])
  // The picked client's current policies — the pre-check that stops a
  // second live Funeral plan from reaching the one-per-product index.
  const [clientPolicies, setClientPolicies] = useState<Array<{ productId: string; productName: string; policyNumber: string; status: string }>>([])

  // Client fields
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  const [clientNationalId, setClientNationalId] = useState('')
  const [clientDob, setClientDob] = useState('')
  const [clientAddress, setClientAddress] = useState('')
  const [clientOccupation, setClientOccupation] = useState('')

  // Policy fields
  const [productId, setProductId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('OneMoney')
  // Cover starts on the 1st of the aligned month (see computeAssignedStartDate),
  // not the day it was captured — only Super Admin/Admin may override this.
  const [startDate, setStartDate] = useState(computeAssignedStartDate())
  const canOverrideStartDate = user?.role === 'super_admin' || user?.role === 'admin'
  // Optional — a policy can carry zero dependants, so this starts empty
  // rather than seeding a mandatory first row.
  const [dependants, setDependants] = useState<Dependant[]>([])
  const [growerNumber, setGrowerNumber] = useState('')
  const [contractor, setContractor] = useState('')
  const [agentId, setAgentId] = useState('')
  // The channel the sale actually came through — defaults to this web app
  // since that's where the staff member is working.
  const [source, setSource] = useState(DEFAULT_POLICY_SOURCE)
  // Cover scope: 'individual' is the domestic flow below (client +
  // dependants). 'corporate'/'group' cover an organisation's roster —
  // the org is the policyholder and is NOT a billed head, only the
  // selected members are (see src/lib/premium.ts).
  const [coverScope, setCoverScope] = useState<CoverScope>('individual')
  const [groups, setGroups] = useState<Group[]>([])
  const [groupId, setGroupId] = useState('')
  // Team scope: the named activity/season the cover is for (e.g. "2026
  // Soccer Season") — team cover is bound to an activity the way
  // corporate/group cover is bound to an organisation.
  const [teamActivity, setTeamActivity] = useState('')
  // Health products (Medical Aid, Hospital Cash) carry an underwriting
  // declaration the sale CANNOT skip: every covered person states whether
  // they have a chronic illness — null means "not answered yet", which
  // keeps the policy un-creatable.
  const [hasChronic, setHasChronic] = useState<boolean | null>(null)
  const [chronicDetails, setChronicDetails] = useState('')
  // Inline "Create New Organisation" — domain-checkout style: pick or
  // register the org without leaving the form and losing context.
  const [showNewOrg, setShowNewOrg] = useState(false)
  const [orgName, setOrgName] = useState('')
  const [orgType, setOrgType] = useState<GroupType>('company')
  const [orgCustomType, setOrgCustomType] = useState('')
  const [orgDesc, setOrgDesc] = useState('')
  const [orgLinePhone, setOrgLinePhone] = useState('')
  const [orgEmail, setOrgEmail] = useState('')
  const [orgAddress, setOrgAddress] = useState('')
  const [orgContactName, setOrgContactName] = useState('')
  const [orgPhone, setOrgPhone] = useState('')
  const [orgContactEmail, setOrgContactEmail] = useState('')
  const [orgSaving, setOrgSaving] = useState(false)
  // Inline member add — a freshly created org has an empty roster, so the
  // flow only completes if members can be enrolled right here too.
  const [showAddMember, setShowAddMember] = useState(false)
  const [memberName, setMemberName] = useState('')
  const [memberNatId, setMemberNatId] = useState('')
  const [memberDob, setMemberDob] = useState('')
  const [memberPhone, setMemberPhone] = useState('')
  const [memberRole, setMemberRole] = useState('')
  const [memberSaving, setMemberSaving] = useState(false)
  const [roster, setRoster] = useState<GroupMember[]>([])
  const [rosterLoading, setRosterLoading] = useState(false)
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set())
  const [products, setProducts] = useState<Product[]>([])
  const [productsLoading, setProductsLoading] = useState(true)
  const [staff, setStaff] = useState<AppUser[]>([])
  const product = products.find(p => p.id === productId)
  const isMedical = product?.category === 'health'

  /** A dependant is covered under the same kind of cover as the policy they
   *  sit on, so the plan picker only ever offers products from the policy's
   *  own category. Offering the full catalogue is how agriculture packages
   *  ended up attached to funeral policies. */
  const dependantPlanOptions = product
    ? products.filter(p => p.active && p.category === product.category)
    : []

  useEffect(() => {
    db.products.list().then(({ data, error }) => {
      if (error) showToast?.('error', 'Failed to load products — the plan list may be empty.')
      if (data) setProducts(data)
      setProductsLoading(false)
    }).catch(() => { showToast?.('error', 'Failed to load products.'); setProductsLoading(false) })
    db.clients.list().then(({ data, error }) => {
      if (error) showToast?.('error', 'Failed to load existing clients.')
      if (data) setExistingClients(data)
    }).catch(() => showToast?.('error', 'Failed to load existing clients.'))
    db.groups.list().then(({ data, error }) => {
      if (error) showToast?.('error', 'Failed to load groups.')
      if (data) setGroups(data.filter(g => g.active))
    }).catch(() => showToast?.('error', 'Failed to load groups.'))
    db.staff.list().then(({ data, error }) => {
      if (error) showToast?.('error', 'Failed to load agents.')
      const active = (data ?? []).filter(s => s.active)
      setStaff(active)
      // Default to whoever is actually creating this policy — the person
      // serving the client — while still letting them reassign it below.
      // A client-bound agent set by selectExistingClient wins over this.
      setAgentId(prev => prev || (user && active.some(s => s.id === user.id) ? user.id : ''))
    }).catch(() => showToast?.('error', 'Failed to load agents.'))
    if (initialClient) selectExistingClient(initialClient)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Changing the product after dependants were given plans would otherwise
  // leave those plans pointing at the previous category's packages.
  useEffect(() => {
    if (!product) return
    setDependants(prev => prev.map(d => {
      if (!d.productId) return d
      const plan = products.find(p => p.id === d.productId)
      if (plan && plan.category === product.category) return d
      return { ...d, productId: undefined, productName: undefined, premium: undefined, coverAmount: undefined }
    }))
  }, [product, products])

  // Picking an organisation loads its roster and pre-selects every active
  // member — the normal case is the whole roster covered, with staff
  // unticking exceptions rather than ticking one by one.
  useEffect(() => {
    if (!groupId) { setRoster([]); setSelectedMemberIds(new Set()); return }
    setRosterLoading(true)
    db.groupMembers.list(groupId).then(({ data, error }) => {
      if (error) showToast?.('error', 'Failed to load the group roster.')
      const active = (data ?? []).filter(m => m.status === 'active')
      setRoster(active)
      setSelectedMemberIds(new Set(active.map(m => m.id)))
      setRosterLoading(false)
    }).catch(() => { showToast?.('error', 'Failed to load the group roster.'); setRosterLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId])

  const toggleMember = (id: string) => {
    setSelectedMemberIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const isGroupScope = coverScope !== 'individual'
  const memberLabel = coverScope === 'corporate' ? 'employee' : coverScope === 'team' ? 'player/member' : 'member'
  const membersCoveredLabel = coverScope === 'corporate' ? 'Employees Covered' : coverScope === 'team' ? 'Team Roster Covered' : 'Members Covered'

  /** Same shape as the picker description — the org created inline lands
   *  in the same list and is selected immediately, checkout-flow style. */
  const createOrganisation = async () => {
    const name = orgName.trim()
    if (!name) { showToast?.('error', 'Give the organisation a name first.'); return }
    if (orgType === 'other' && !orgCustomType.trim()) { showToast?.('error', 'Type is “Other” — give the organisation type a name (e.g. School, NGO).'); return }
    if (!orgContactName.trim()) { showToast?.('error', 'Name the representative / contact person.'); return }
    setOrgSaving(true)
    // Nothing is registered if the server can't confirm it — the org
    // gets a retry prompt instead of a half-done record.
    if (!(await serverReachable())) {
      setOrgSaving(false)
      showToast?.('error', 'The server is unreachable right now — nothing was registered. Try again in a moment.')
      return
    }
    const { data, error } = await db.groups.create({
      name,
      groupType: orgType,
      customType: orgType === 'other' ? orgCustomType.trim() : undefined,
      description: orgDesc.trim() || undefined,
      orgPhone: orgLinePhone.trim() || undefined,
      orgEmail: orgEmail.trim() || undefined,
      address: orgAddress.trim() || undefined,
      contactName: orgContactName.trim(),
      contactPhone: orgPhone.trim() || undefined,
      contactEmail: orgContactEmail.trim() || undefined,
    })
    setOrgSaving(false)
    if (error || !data) {
      showToast?.('error', error ?? 'Could not register the organisation. If the Groups feature is new, run database/add_group_cover.sql in Supabase first.')
      return
    }
    setGroups(prev => [...prev, { ...data, active: true }].sort((a, b) => a.name.localeCompare(b.name)))
    setGroupId(data.id)
    setShowNewOrg(false)
    // Inline or dedicated page, the organisation gets the same
    // registration text — the channel shouldn't change the record.
    void notifyGroupRegistered(data)
    setOrgName(''); setOrgCustomType(''); setOrgDesc(''); setOrgLinePhone(''); setOrgEmail(''); setOrgAddress(''); setOrgContactName(''); setOrgPhone(''); setOrgContactEmail('')
    showToast?.('success', `${data.name} registered — add its ${coverScope === 'corporate' ? 'employees' : 'members'} below, then finish the policy.`)
  }

  const addRosterMember = async () => {
    const name = memberName.trim()
    if (!name) { showToast?.('error', 'Give the member a name first.'); return }
    setMemberSaving(true)
    const { data, error } = await db.groupMembers.add({
      groupId,
      fullName: name,
      nationalId: memberNatId.trim() || undefined,
      dob: memberDob || undefined,
      phone: memberPhone.trim() || undefined,
      position: memberRole.trim() || undefined,
    })
    setMemberSaving(false)
    if (error || !data) { showToast?.('error', error ?? 'Could not add the member.'); return }
    setRoster(prev => [...prev, data])
    setSelectedMemberIds(prev => new Set(prev).add(data.id))
    setMemberName(''); setMemberNatId(''); setMemberDob(''); setMemberPhone(''); setMemberRole('')
  }

  const switchScope = (scope: CoverScope) => {
    setCoverScope(scope)
    // Sensible org-type default for the inline registration form.
    setOrgType(scope === 'corporate' ? 'company' : scope === 'team' ? 'sports' : 'other')
  }

  const clearClientFields = () => {
    setClientName(''); setClientPhone(''); setClientEmail(''); setClientNationalId('')
    setClientDob(''); setClientAddress(''); setClientOccupation('')
  }

  const switchMode = (mode: 'new' | 'existing') => {
    setCustomerMode(mode)
    setExistingClientId('')
    setClientSearch('')
    setClientPolicies([])
    clearClientFields()
  }

  const clientSearchResults = clientSearch.trim().length < 2 ? [] : existingClients.filter(c =>
    c.name.toLowerCase().includes(clientSearch.trim().toLowerCase()) ||
    c.phone.includes(clientSearch.trim()) ||
    c.nationalId.toLowerCase().includes(clientSearch.trim().toLowerCase())
  ).slice(0, 8)

  const selectExistingClient = (client: Client) => {
    setExistingClientId(client.id)
    setClientSearch(`${client.name} (${client.phone})`)
    setClientName(client.name)
    setClientPhone(client.phone)
    setClientEmail(client.email)
    setClientNationalId(client.nationalId)
    setClientDob(client.dob)
    setClientAddress(client.address)
    setClientOccupation(client.occupation ?? '')
    // A client already bound to an agent (registered by one) keeps them
    // as the policy's agent — override below if that's wrong for this sale.
    if (client.agentId) setAgentId(client.agentId)
    db.policies.listForClient(client.id).then(({ data }) => { if (data) setClientPolicies(data) }).catch(() => {})
  }

  const addDependant = () => {
    // Field-to-Floor cover is the policyholder and ONE spouse for the
    // funeral benefit — a second dependant can never exist on it.
    if (product?.category === 'agriculture' && dependants.length >= 1) {
      showToast?.('warning', 'Tobacco cover is the policyholder and one spouse only — no other dependants can be added.')
      return
    }
    setDependants(prev => [...prev, {
      name: '',
      relationship: product?.category === 'agriculture' ? 'Spouse' : '',
      dob: '', nationalId: '',
    }])
  }

  const removeDependant = (i: number) => {
    setDependants(prev => prev.filter((_, idx) => idx !== i))
  }

  const updateDependant = (i: number, field: keyof Dependant, value: string | boolean | undefined) => {
    setDependants(prev => prev.map((d, idx) => {
      if (idx !== i) return d
      const next = { ...d, [field]: value }
      if (field === 'productId') {
        const plan = products.find(p => p.id === value)
        next.productName = plan?.name
        next.premium = plan?.premium
        next.coverAmount = plan?.coverAmount
      }
      return next
    }))
  }

  const clientAge = clientDob ? Math.floor((Date.now() - new Date(clientDob).getTime()) / (365.25 * 24 * 3600 * 1000)) : null
  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (customerMode === 'existing' && !existingClientId) missing.push({ key: 'existingClient', label: 'Customer search', hint: 'Search and pick the customer from the list' })
  if (!clientName.trim()) missing.push({ key: 'clientName', label: 'Full Name' })
  if (!clientPhone.trim()) missing.push({ key: 'clientPhone', label: 'Phone Number' })
  if (!clientNationalId.trim()) missing.push({ key: 'clientNationalId', label: 'National ID' })
  // National ID is unique — catch a re-registration before it reaches
  // the database: same person must be picked via "Existing Customer".
  const duplicateNatId = customerMode === 'new' && clientNationalId.trim()
    ? existingClients.find(c => c.nationalId.toLowerCase() === clientNationalId.trim().toLowerCase())
    : undefined
  if (duplicateNatId) missing.push({ key: 'clientNationalId', label: 'National ID', hint: `Already registered to ${duplicateNatId.name} — switch to "Existing Customer" above` })
  if (!clientDob) missing.push({ key: 'clientDob', label: 'Date of Birth' })
  else if (clientAge !== null && clientAge < 18) missing.push({ key: 'clientDob', label: 'Date of Birth', hint: 'The policyholder must be at least 18' })
  if (!productId) missing.push({ key: 'productId', label: 'Product' })
  // One live policy per client per product (DB partial unique index:
  // active | waiting_period). Warn before the save hits it — the staff
  // member picks another product, or lapses the old one first.
  const liveProductClash = existingClientId && productId
    ? clientPolicies.find(p => p.productId === productId && (p.status === 'active' || p.status === 'waiting_period'))
    : undefined
  if (liveProductClash) missing.push({ key: 'productId', label: 'Product', hint: `Already holds ${liveProductClash.policyNumber} (${liveProductClash.status.replace(/_/g, ' ')}) on this product` })
  if (isGroupScope) {
    if (!groupId) missing.push({ key: 'groupId', label: 'Organisation', hint: 'Pick one, or register a new one with "+ Create New Organisation"' })
    else if (selectedMemberIds.size === 0) missing.push({ key: 'members', label: membersCoveredLabel, hint: 'Tick at least one roster member' })
    if (coverScope === 'team' && !teamActivity.trim()) missing.push({ key: 'teamActivity', label: 'Activity / Event', hint: 'Team cover is for a named activity or season' })
  } else if (dependants.some(d => d.name.trim() && (!d.dob || !d.nationalId.trim()))) {
    missing.push({ key: 'dependants', label: 'Dependant details', hint: 'Every dependant needs a name, date of birth and ID number' })
  }
  if (isMedical) {
    if (hasChronic === null) missing.push({ key: 'chronic', label: 'Chronic illness declaration', hint: 'Medical aid requires an answer — yes or no' })
    else if (hasChronic && !chronicDetails.trim()) missing.push({ key: 'chronic', label: 'Chronic illness details', hint: 'State the condition(s) declared' })
    if (dependants.some(d => d.name.trim() && d.hasChronicIllness === undefined)) {
      missing.push({ key: 'dependants', label: 'Dependant declaration', hint: 'Answer the chronic illness question for every dependant on this medical plan' })
    }
  }

  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    // No silent nothing: any throw — network drop, a DB rejection that
    // escaped a {error} return, a missing product row — lands in a toast
    // and leaves the modal open, and the button locks for the duration so
    // a double-click can't create the client twice.
    setAttempted(true)
    if (missing.length > 0 || saving) return
    setSaving(true)
    try {
      await doSave()
    } catch (e) {
      showToast?.('error', `Policy was not created: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const doSave = async () => {
    if (!isGroupScope) {
      const overValue = dependants.find(d => (d.premium ?? 0) > product!.premium || (d.coverAmount ?? 0) > product!.coverAmount)
      if (overValue) {
        if (showToast) showToast('error', `${overValue.name || 'A dependant'}'s plan premium and cover cannot exceed the policyholder's.`)
        return
      }
    }

    // Server-side rule: a registration is owed a confirmation, and the
    // confirmation is a server call. If the server can't even be
    // reached, nothing is written — the capturer retries instead of a
    // client/policy existing with nobody told.
    if (!(await serverReachable())) {
      if (showToast) showToast('error', 'The server is unreachable right now — nothing was registered. Try again in a moment.')
      return
    }

    // Existing customer: update their record in place (details may have
    // changed since they were first registered) rather than creating a
    // duplicate client row — this is what lets one person hold more than
    // one policy.
    let createdClient: Client | null
    if (customerMode === 'existing' && existingClientId) {
      // Backfill only: a client who already has a referring agent keeps
      // them — the Agent field above is the policy's attribution, not a
      // reassignment of who brought the client in.
      const clientRecord = existingClients.find(c => c.id === existingClientId)
        ?? (initialClient?.id === existingClientId ? initialClient : undefined)
      const { data, error } = await db.clients.update(existingClientId, {
        name: clientName, email: clientEmail, phone: clientPhone,
        address: clientAddress, occupation: clientOccupation,
        agentId: (!clientRecord?.agentId && agentId) ? agentId : undefined,
      })
      if (error || !data) { if (showToast) showToast('error', error ?? 'Failed to update client.'); return }
      createdClient = data
    } else {
      const newClient: Client = {
        id: `c${Date.now()}`,
        name: clientName,
        email: clientEmail,
        phone: clientPhone,
        nationalId: clientNationalId,
        dob: clientDob,
        address: clientAddress,
        occupation: clientOccupation,
        createdAt: toIsoDate(new Date()),
        policyCount: 0,
        status: 'active',
        // Registering a fresh client through this modal is the same act as
        // an agent bringing them in, so the chosen agent binds to the
        // client record itself, not only to this one policy.
        agentId: agentId || undefined,
      }
      const { data, error } = await db.clients.create(newClient)
      // Surface the real reason — a duplicate national ID, an RLS refusal,
      // a dropped connection all read very differently to "failed".
      if (error || !data) { if (showToast) showToast('error', error ?? 'Failed to create client.'); return }
      createdClient = data
    }

    // Group-scope policies carry the selected roster members in the
    // dependants array — relationship 'Employee'/'Member' marks them as
    // organisational cover on documents and member statements. Teams keep
    // the member's role (Player, Coach, Captain…) — it's what makes a
    // team document read like a squad sheet.
    const selectedGroup = groups.find(g => g.id === groupId)
    const memberDependants: Dependant[] = isGroupScope
      ? roster.filter(m => selectedMemberIds.has(m.id)).map(m => ({
          name: m.fullName,
          relationship: coverScope === 'corporate' ? 'Employee'
            : coverScope === 'team' ? (m.position?.trim() || 'Team Member')
            : 'Member',
          dob: m.dob ?? '',
          nationalId: m.nationalId ?? '',
          phone: m.phone,
          productId, productName: product!.name,
          premium: product!.premium, coverAmount: product!.coverAmount,
        }))
      : product!.category === 'agriculture'
        ? dependants.slice(0, 1).map(d => ({ ...d, relationship: 'Spouse' }))
        : dependants

    // Create policy with the client. The number is drawn from the
    // product's sequence (FCP0001, HCP0042, ...) — short, and the prefix
    // alone says which cover it belongs to.
    const policyNumber = await nextPolicyNumber(product!)
    const endDate = new Date(startDate)
    endDate.setFullYear(endDate.getFullYear() + 1)
    const policy: Policy = {
      id: `pol${Date.now()}`,
      policyNumber,
      clientId: createdClient.id,
      clientName: createdClient.name,
      productId,
      productName: product!.name,
      premium: product!.premium,
      coverAmount: product!.coverAmount,
      startDate,
      endDate: toIsoDate(endDate),
      // Every new policy starts in a waiting period, lifted to active after
      // 90 days — except agriculture, which has NO waiting period at all,
      // and team cover, which is bound to a named activity/event and so
      // can't sit in a waiting period — a team insured for a match on
      // Saturday needs cover from the day it is issued.
      status: product!.category === 'agriculture' || coverScope === 'team' ? 'active' : 'waiting_period',
      dependants: memberDependants,
      groupId: isGroupScope ? groupId : undefined,
      groupName: isGroupScope ? selectedGroup?.name : undefined,
      coverScope,
      teamActivity: coverScope === 'team' ? teamActivity.trim() : undefined,
      paymentMethod,
      growerNumber: product!.category === 'agriculture' ? (growerNumber || undefined) : undefined,
      contractor: product!.category === 'agriculture' ? (contractor.trim() || undefined) : undefined,
      createdAt: toIsoDate(new Date()),
      nextPaymentDate: toIsoDate(new Date(new Date(startDate).setMonth(new Date(startDate).getMonth() + (product!.category === 'agriculture' ? 12 : 1)))),
      agentId: agentId || undefined,
      agentName: staff.find(s => s.id === agentId)?.name,
      source,
      hasChronicIllness: isMedical ? hasChronic ?? undefined : undefined,
      chronicIllnessDetails: isMedical && hasChronic ? chronicDetails.trim() : undefined,
    }
    await Promise.resolve(onSave(policy))
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 900 }}>
        <div className="modal-header">
          <h3>New Policy</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          {!initialClient && (
            <div className="bubble-toggle" style={{ marginBottom: '1rem' }}>
              <button
                type="button"
                className={`bubble-toggle-btn${customerMode === 'new' ? ' active' : ''}`}
                onClick={() => switchMode('new')}
              >
                New Customer
              </button>
              <button
                type="button"
                className={`bubble-toggle-btn${customerMode === 'existing' ? ' active' : ''}`}
                onClick={() => switchMode('existing')}
              >
                Existing Customer
              </button>
            </div>
          )}

          {customerMode === 'existing' && !initialClient && (
            <div className="form-group" id={fieldId('existingClient')} style={{ position: 'relative', marginBottom: '1rem' }}>
              <label>Search Customer * (name, phone, or ID number)</label>
              <input
                className={invalidClass(missing, attempted, 'existingClient')}
                placeholder="Start typing to search…"
                value={clientSearch}
                onChange={e => { setClientSearch(e.target.value); setExistingClientId(''); setClientPolicies([]) }}
              />
              {clientSearchResults.length > 0 && !existingClientId && (
                <div className="search-suggestions">
                  {clientSearchResults.map(c => (
                    <button type="button" key={c.id} className="search-suggestion-item" onClick={() => selectExistingClient(c)}>
                      <strong>{c.name}</strong> · {c.phone} · {c.nationalId}
                    </button>
                  ))}
                </div>
              )}
              {existingClientId && (
                <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 4 }}>✓ Customer selected, details autofilled below.</p>
              )}
            </div>
          )}

          <div className="new-policy-cols">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h4 style={{ margin: 0 }}>Customer Information{existingClientId && <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}> (on file, read only)</span>}</h4>
              <div className="form-group" id={fieldId('clientName')}>
                <label>Full Name *</label>
                <input className={invalidClass(missing, attempted, 'clientName')} placeholder="Enter full name" value={clientName} onChange={e => setClientName(e.target.value)} disabled={!!existingClientId} style={existingClientId ? { opacity: 0.6 } : undefined} />
              </div>
              <div className="form-group" id={fieldId('clientPhone')} style={isMissing(missing, attempted, 'clientPhone') ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
                <label>Phone Number *</label>
                <PhoneInput value={clientPhone} onChange={setClientPhone} disabled={!!existingClientId} />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" className="form-control" placeholder="email@example.com" value={clientEmail} onChange={e => setClientEmail(e.target.value)} disabled={!!existingClientId} style={existingClientId ? { opacity: 0.6 } : undefined} />
              </div>
              <div className="form-group" id={fieldId('clientNationalId')}>
                <label>National ID *</label>
                <input className={invalidClass(missing, attempted, 'clientNationalId')} placeholder="e.g. 632118532K12" value={clientNationalId} onChange={e => setClientNationalId(e.target.value.replace(/-/g, ''))} disabled={!!existingClientId} style={existingClientId ? { opacity: 0.6 } : undefined} />
                {/* Warn the moment a known ID is typed — before the save
                    button, not after a round-trip to a unique constraint. */}
                {duplicateNatId && (
                  <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
                    Already registered to {duplicateNatId.name} — switch to "Existing Customer" and pick them there.
                  </p>
                )}
              </div>
              <div className="form-group" id={fieldId('clientDob')} style={isMissing(missing, attempted, 'clientDob') ? { outline: '1px solid var(--danger)', borderRadius: 7, outlineOffset: 2 } : undefined}>
                <label>Date of Birth * (18+)</label>
                <DateInput value={clientDob} onChange={setClientDob} disabled={!!existingClientId} className={existingClientId ? 'date-input-disabled' : undefined} />
              </div>
              <div className="form-group">
                <label>Occupation</label>
                <input className="form-control" placeholder="e.g. Teacher" value={clientOccupation} onChange={e => setClientOccupation(e.target.value)} disabled={!!existingClientId} style={existingClientId ? { opacity: 0.6 } : undefined} />
              </div>
              <div className="form-group">
                <label>Address</label>
                <input className="form-control" placeholder="Street address, city" value={clientAddress} onChange={e => setClientAddress(e.target.value)} disabled={!!existingClientId} style={existingClientId ? { opacity: 0.6 } : undefined} />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h4 style={{ margin: 0 }}>Policy Information</h4>
              <div className="form-group">
                <label>Cover Scope *</label>
                <div className="bubble-toggle">
                  <button type="button" className={`bubble-toggle-btn${coverScope === 'individual' ? ' active' : ''}`} onClick={() => switchScope('individual')}>Individual / Family</button>
                  <button type="button" className={`bubble-toggle-btn${coverScope === 'corporate' ? ' active' : ''}`} onClick={() => switchScope('corporate')}>Corporate</button>
                  <button type="button" className={`bubble-toggle-btn${coverScope === 'group' ? ' active' : ''}`} onClick={() => switchScope('group')}>Group</button>
                  <button type="button" className={`bubble-toggle-btn${coverScope === 'team' ? ' active' : ''}`} onClick={() => switchScope('team')}>Teams</button>
                </div>
                {isGroupScope && (
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    {coverScope === 'corporate'
                      ? 'A company covering its employees under one policy. The client below is the account holder (e.g. HR contact); the company is the insured organisation.'
                      : coverScope === 'team'
                        ? 'A team — sports squad, work crew, tour group — covered for a named activity or season. Roster members carry a role (player, coach…), and cover activates immediately: a match this weekend can\'t wait out a 90-day waiting period.'
                        : 'An association — church, union, sports club — covering its members under one policy. The client below is the account holder (e.g. secretary).'}
                  </p>
                )}
              </div>
              {isGroupScope && (
                <div className="form-group" id={fieldId('groupId')}>
                  <label>Organisation *</label>
                  <select className={invalidClass(missing, attempted, 'groupId')} value={groupId} onChange={e => setGroupId(e.target.value)} disabled={showNewOrg}>
                    <option value="">{groups.length === 0 ? 'No organisations registered yet' : 'Select organisation…'}</option>
                    {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.memberCount ?? 0} members)</option>)}
                  </select>
                  {/* Domain-checkout pattern: registering the org happens
                      right here at the point of need — no leaving to the
                      Groups page and losing the half-filled form. */}
                  {!showNewOrg ? (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setShowNewOrg(true)}>
                      + Create New Organisation
                    </button>
                  ) : (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 6, background: 'var(--surface)' }}>
                      <div className="form-row" style={{ marginBottom: 8 }}>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: 11 }}>Organisation Name *</label>
                          <input className="form-control" placeholder={coverScope === 'corporate' ? 'e.g. Acme Pvt Ltd' : coverScope === 'team' ? 'e.g. Dynamos FC — Senior Squad' : 'e.g. Glen View Church'} value={orgName} onChange={e => setOrgName(e.target.value)} />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: 11 }}>Type *</label>
                          <select className="form-control" value={orgType} onChange={e => setOrgType(e.target.value as GroupType)}>
                            <option value="company">Company</option>
                            <option value="church">Church</option>
                            <option value="union">Union</option>
                            <option value="sports">Sports Team/Club</option>
                            <option value="club">Club</option>
                            <option value="society">Society</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                        {orgType === 'other' && (
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label style={{ fontSize: 11 }}>Custom Type *</label>
                            <input className="form-control" placeholder="School, NGO, SACCO…" value={orgCustomType} onChange={e => setOrgCustomType(e.target.value)} />
                          </div>
                        )}
                        {/* Number of Users removed — the roster IS the
                            count; an "expected" figure is fiction. */}
                      </div>
                      <div className="form-group" style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: 11 }}>Description / Needs</label>
                        <textarea className="form-control" rows={2} placeholder="What they want covered — demography, age ranges, activity (e.g. travel cover for a school tour)…" value={orgDesc} onChange={e => setOrgDesc(e.target.value)} />
                      </div>
                      <div className="form-row" style={{ marginBottom: 8 }}>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: 11 }}>Organisation Phone</label>
                          <PhoneInput value={orgLinePhone} onChange={setOrgLinePhone} />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: 11 }}>Organisation Email</label>
                          <input type="email" className="form-control" placeholder="info@org.co.zw" value={orgEmail} onChange={e => setOrgEmail(e.target.value)} />
                        </div>
                      </div>
                      <div className="form-group" style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: 11 }}>Address</label>
                        <input className="form-control" placeholder="Physical / postal address" value={orgAddress} onChange={e => setOrgAddress(e.target.value)} />
                      </div>
                      <div className="form-row" style={{ marginBottom: 8 }}>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: 11 }}>Representative Name *</label>
                          <input className="form-control" placeholder={coverScope === 'corporate' ? 'HR officer' : coverScope === 'team' ? 'Coach or manager' : 'Secretary, chairperson'} value={orgContactName} onChange={e => setOrgContactName(e.target.value)} />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: 11 }}>Representative Phone</label>
                          <PhoneInput value={orgPhone} onChange={setOrgPhone} />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: 11 }}>Representative Email</label>
                          <input type="email" className="form-control" placeholder="person@org.co.zw" value={orgContactEmail} onChange={e => setOrgContactEmail(e.target.value)} />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="btn btn-primary btn-sm" disabled={orgSaving} onClick={() => void createOrganisation()}>
                          {orgSaving ? 'Registering…' : 'Register & Select'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowNewOrg(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Full roster management lives on the Groups page — members can be added below after picking an organisation.</p>
                </div>
              )}
              {coverScope === 'team' && (
                <div className="form-group" id={fieldId('teamActivity')}>
                  <label>Activity / Event / Season *</label>
                  <input className={invalidClass(missing, attempted, 'teamActivity')} placeholder="e.g. 2026 Soccer Season, Easter Tournament, Project Chimanimani" value={teamActivity} onChange={e => setTeamActivity(e.target.value)} />
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>What the team is being covered for — printed on the policy document.</p>
                </div>
              )}
              <div className="form-group" id={fieldId('productId')}>
                <label>Product *</label>
                <select className={invalidClass(missing, attempted, 'productId')} value={productId} onChange={e => setProductId(e.target.value)} disabled={productsLoading}>
                  <option value="">{productsLoading ? 'Loading products…' : 'Select product…'}</option>
                  {products.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.name} (${p.premium}{premiumPeriodLabel(p.category)})</option>)}
                </select>
                {liveProductClash && (
                  <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
                    {clientName || 'This client'} already holds {liveProductClash.policyNumber} ({liveProductClash.status.replace(/_/g, ' ')}) on this product — pick another product, or lapse the existing policy first.
                  </p>
                )}
              </div>
              {product && (
                <div className="info-banner info-banner-info">
                  Cover: ${product.coverAmount.toLocaleString()} · Premium: ${product.premium}{premiumPeriodLabel(product.category)} · Commission: {product.commissionPct}%
                </div>
              )}
              {product?.category === 'agriculture' && (
                <div className="form-row">
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Grower Number</label>
                    <input className="form-control" placeholder="Grower registration number" value={growerNumber} onChange={e => setGrowerNumber(e.target.value)} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Contractor</label>
                    <input className="form-control" placeholder="The merchant the grower is contracted to" value={contractor} onChange={e => setContractor(e.target.value)} />
                  </div>
                  {/* Tobacco industry language: the agent working a grower
                      book is the Field Officer. Same agent_id — just the
                      right word, and office staff can't fill it. */}
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Field Officer</label>
                    <select className="form-control" value={agentId} onChange={e => setAgentId(e.target.value)}>
                      <option value="">Unassigned</option>
                      {staff.filter(s => s.role === 'agent').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {isMedical && (
                <div id={fieldId('chronic')} className={isMissing(missing, attempted, 'chronic') ? 'field-invalid-block' : undefined}
                  style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 8, background: 'var(--surface)' }}>
                  <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
                    Medical Declaration — required
                  </label>
                  <div className="form-group" style={{ marginTop: 8, marginBottom: 0 }}>
                    <label>Does {clientName.trim() || 'the policyholder'} have any chronic illness? *</label>
                    <div style={{ display: 'flex', gap: 16 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                        <input type="radio" name="chronic" checked={hasChronic === true} onChange={() => setHasChronic(true)} /> Yes
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                        <input type="radio" name="chronic" checked={hasChronic === false} onChange={() => { setHasChronic(false); setChronicDetails('') }} /> No
                      </label>
                    </div>
                  </div>
                  {hasChronic && (
                    <div className="form-group" style={{ marginTop: 8, marginBottom: 0 }}>
                      <label>Which chronic condition(s)? *</label>
                      <input className={invalidClass(missing, attempted, 'chronic')} placeholder="e.g. Hypertension, diabetes, asthma — as declared by the client" value={chronicDetails} onChange={e => setChronicDetails(e.target.value)} />
                      <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Recorded on the policy — claims review reads this declaration.</p>
                    </div>
                  )}
                </div>
              )}
              <div className="form-group">
                <label>Start Date *</label>
                <DateInput value={startDate} onChange={setStartDate} disabled={!canOverrideStartDate} className={!canOverrideStartDate ? 'date-input-disabled' : undefined} />
                {!canOverrideStartDate && (
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Auto-set from today's date. Only Super Admin/Admin can change it.</p>
                )}
              </div>
              <div className="form-group">
                <label>Payment Method *</label>
                <select className="form-control" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                  {MANUAL_PAYMENT_METHODS.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              {/* On agriculture the agent above is the Field Officer —
                  same agent_id, picked once in the grower block; a second
                  picker here would just duplicate the same value. */}
              {product?.category !== 'agriculture' && (
              <div className="form-group">
                <label>Agent (Referred By)</label>
                <select className="form-control" value={agentId} onChange={e => setAgentId(e.target.value)}>
                  <option value="">Unassigned</option>
                  {/* Field agents and office staff are different books —
                      commission belongs to the agent who brought the sale,
                      so the picker names the group instead of trusting the
                      capturer to know who's an agent. */}
                  <optgroup label="Agents">
                    {staff.filter(s => s.role === 'agent').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                  <optgroup label="Office Staff">
                    {staff.filter(s => s.role !== 'agent').map(s => <option key={s.id} value={s.id}>{s.name} ({s.role.replace(/_/g, ' ')})</option>)}
                  </optgroup>
                </select>
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Optional — the agent who brought this client in. Defaults to you; a new client is bound to the same agent.</p>
              </div>
              )}
              <div className="form-group">
                <label>Issued Via *</label>
                <select className="form-control" value={source} onChange={e => setSource(e.target.value)}>
                  {POLICY_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Where this sale came through — recorded on the policy.</p>
              </div>
            </div>
          </div>

          {isGroupScope ? (
            <div id={fieldId('members')} className={isMissing(missing, attempted, 'members') ? 'field-invalid-block' : undefined} style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                <label>{membersCoveredLabel} ({selectedMemberIds.size} of {roster.length} selected)</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {groupId && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAddMember(o => !o)}>
                      {showAddMember ? 'Close' : `+ Add ${coverScope === 'corporate' ? 'Employee' : coverScope === 'team' ? 'Player/Member' : 'Member'}`}
                    </button>
                  )}
                  {roster.length > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedMemberIds(prev => prev.size === roster.length ? new Set() : new Set(roster.map(m => m.id)))}>
                      {selectedMemberIds.size === roster.length ? 'Deselect all' : 'Select all'}
                    </button>
                  )}
                </div>
              </div>
              {/* Checkout-flow member add: the org's roster can be built at
                  the point of need — same place the members get selected. */}
              {showAddMember && groupId && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 8, background: 'var(--surface)' }}>
                  <div className="form-row" style={{ marginBottom: 8 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>Full Name *</label>
                      <input className="form-control" placeholder={`${coverScope === 'corporate' ? 'Employee' : 'Member'} name`} value={memberName} onChange={e => setMemberName(e.target.value)} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>{coverScope === 'team' ? 'Role' : coverScope === 'corporate' ? 'Job Title' : 'Role'}</label>
                      <input className="form-control" placeholder={coverScope === 'team' ? 'Player, Coach, Captain…' : 'e.g. Cashier'} value={memberRole} onChange={e => setMemberRole(e.target.value)} />
                    </div>
                  </div>
                  <div className="form-row" style={{ marginBottom: 8 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>National ID</label>
                      <input className="form-control" value={memberNatId} onChange={e => setMemberNatId(e.target.value.replace(/-/g, ''))} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>Date of Birth</label>
                      <DateInput value={memberDob} onChange={setMemberDob} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>Phone</label>
                      <PhoneInput value={memberPhone} onChange={setMemberPhone} />
                    </div>
                  </div>
                  <button type="button" className="btn btn-primary btn-sm" disabled={memberSaving} onClick={() => void addRosterMember()}>
                    {memberSaving ? 'Adding…' : `Add ${memberLabel}`}
                  </button>
                </div>
              )}
              {!groupId ? (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>Pick an organisation above to load its roster.</p>
              ) : rosterLoading ? (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>Loading roster…</p>
              ) : roster.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                  This organisation has no active {coverScope === 'corporate' ? 'employees' : 'members'} yet — use "+ Add {coverScope === 'corporate' ? 'Employee' : 'Member'}" above to enrol the first one.
                </p>
              ) : (
                <>
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                    {roster.map(m => (
                      <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={selectedMemberIds.has(m.id)} onChange={() => toggleMember(m.id)} />
                        <span style={{ flex: 1 }}>
                          <strong>{m.fullName}</strong>
                          {m.position && <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {m.position}</span>}
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{[m.memberNo, m.nationalId].filter(Boolean).join(' · ') || 'No ID on file'}</div>
                        </span>
                        {product && <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>${product.premium.toFixed(2)}</span>}
                      </label>
                    ))}
                  </div>
                  {product && selectedMemberIds.size > 0 && (
                    <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                      Billed: <strong style={{ color: 'var(--text)' }}>${(product.premium * selectedMemberIds.size).toFixed(2)}{premiumPeriodLabel(product.category)}</strong>
                      {' '}({selectedMemberIds.size} {selectedMemberIds.size === 1 ? 'member' : 'members'} × ${product.premium.toFixed(2)} — the organisation itself is not a billed head)
                    </p>
                  )}
                </>
              )}
            </div>
          ) : (
          <div id={fieldId('dependants')} className={isMissing(missing, attempted, 'dependants') ? 'field-invalid-block' : undefined} style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label>Dependants</label>
              <button type="button" className="btn btn-ghost btn-sm" onClick={addDependant}>+ Add Dependant</button>
            </div>
            {dependants.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>No dependants added.</p>
            ) : (
              <>
                <div className="new-policy-dependant-row" style={{ marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Name</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Relationship</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Date of Birth</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>ID / Birth Record No.</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Plan</span>
                  <span />
                </div>
                {dependants.map((d, i) => (
                  <div key={i}>
                    <div className="new-policy-dependant-row" style={{ marginBottom: isMedical ? 4 : 8, alignItems: 'center' }}>
                      <input className="form-control" placeholder="Name" value={d.name} onChange={e => updateDependant(i, 'name', e.target.value)} />
                      {product?.category === 'agriculture' ? (
                        // The funeral benefit covers the holder's spouse
                        // only — locked, not a free relationship field.
                        <input className="form-control" value="Spouse" readOnly title="Tobacco cover is the policyholder and one spouse only" style={{ opacity: 0.7 }} />
                      ) : (
                        <input className="form-control" placeholder="Relationship" value={d.relationship} onChange={e => updateDependant(i, 'relationship', e.target.value)} />
                      )}
                      <DateInput value={d.dob} onChange={v => updateDependant(i, 'dob', v)} />
                      <input className="form-control" placeholder="ID (16+) or birth record no." value={d.nationalId} onChange={e => updateDependant(i, 'nationalId', e.target.value.replace(/-/g, ''))} />
                      <select className="form-control" value={d.productId ?? ''} onChange={e => updateDependant(i, 'productId', e.target.value)} disabled={!product}>
                        <option value="">{product ? 'Select plan…' : 'Pick the product first'}</option>
                        {dependantPlanOptions.map(p => <option key={p.id} value={p.id}>{p.name} (${p.premium})</option>)}
                      </select>
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => removeDependant(i)} title="Remove dependant">✕</button>
                    </div>
                    {isMedical && d.name.trim() && (
                      <div className="form-row" style={{ marginBottom: 8 }}>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: 11 }}>Chronic illness for {d.name.trim()}? *</label>
                          <select className="form-control" value={d.hasChronicIllness === undefined ? '' : d.hasChronicIllness ? 'yes' : 'no'}
                            onChange={e => updateDependant(i, 'hasChronicIllness', e.target.value === '' ? undefined : e.target.value === 'yes')}>
                            <option value="">Answer…</option>
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                          </select>
                        </div>
                        {d.hasChronicIllness && (
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label style={{ fontSize: 11 }}>Condition(s)</label>
                            <input className="form-control" placeholder="e.g. Diabetes" value={d.chronicIllnessDetails ?? ''} onChange={e => updateDependant(i, 'chronicIllnessDetails', e.target.value)} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Creating…' : customerMode === 'existing' ? 'Create Policy' : 'Create Policy & Register Client'}
          </button>
        </div>
      </div>
    </div>
  )
}
