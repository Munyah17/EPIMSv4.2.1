import { useEffect, useState } from 'react'
import { db } from '../../lib/db'
import { useAuth } from '../../contexts/AuthContext'
import type { Policy } from '../../types'

export interface PolicyholderScope {
  /** The signed-in policyholder's own policies — already filtered to their
   *  client record(s). */
  policies: Policy[]
  /** IDs of the client record(s) this login owns. */
  clientIds: Set<string>
  /** IDs of their policies — claims and payments link to a policy, not
   *  directly to a client, so this is the scoping key for those lists. */
  policyIds: Set<string>
  loading: boolean
  error: string | null
}

const EMPTY: PolicyholderScope = {
  policies: [], clientIds: new Set(), policyIds: new Set(), loading: false, error: null,
}

/**
 * Shared scoping for every "My …" portal page.
 *
 * What a policyholder may see is decided by RLS at the database — clients,
 * policies, claims and payments are all matched to the login's email
 * (clients_select_own / policies_select_own / owns_policy). That is the
 * authoritative scope, and it does not break when a policyholder edits
 * their own profile.
 *
 * The client-side check below exists for one reason: db.*.list() falls
 * back to an offline cache that holds whatever the LAST account on this
 * browser fetched. On a shared device that can be a staff member's full
 * book, so results are re-verified against the client IDs whose email
 * matches the signed-in login. This replaced a `clientName === user.name`
 * string match, which both leaked across same-named clients and hid a
 * policyholder's own rows the moment their profile name drifted from the
 * client record — a self-service name edit (profiles_update_own allows
 * it) was enough to empty their portal.
 *
 * It fails closed: if the client list can't be confirmed, the pages show
 * the error rather than data that can't be verified as theirs.
 */
export function usePolicyholderScope(): PolicyholderScope {
  const { user } = useAuth()
  const [scope, setScope] = useState<PolicyholderScope>({ ...EMPTY, loading: true })

  useEffect(() => {
    if (!user) {
      setScope(EMPTY)
      return
    }
    let cancelled = false
    const email = user.email.toLowerCase()
    Promise.all([db.clients.list(), db.policies.list()]).then(([clientsRes, policiesRes]) => {
      if (cancelled) return
      const clientIds = new Set(
        (clientsRes.data ?? []).filter(c => c.email.toLowerCase() === email).map(c => c.id),
      )
      const policies = (policiesRes.data ?? []).filter(p => clientIds.has(p.clientId))
      setScope({
        policies,
        clientIds,
        policyIds: new Set(policies.map(p => p.id)),
        loading: false,
        error: clientsRes.error ?? policiesRes.error,
      })
    })
    return () => { cancelled = true }
  }, [user])

  return scope
}
