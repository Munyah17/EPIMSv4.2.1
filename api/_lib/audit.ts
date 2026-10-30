/**
 * Audit logging: persistent records of administrative edits and changes.
 * Every super admin or authorised staff edit to a client, policy, or other
 * entity is logged for accountability and traceability.
 *
 * This function is called server-side (from API endpoints) when a user
 * with appropriate privileges makes a change. It writes to audit_log and
 * captures who, what, when, before/after values, and context.
 */

import { serviceClient } from './sessionAuth.js'
import { fetchAllRows } from '../../src/lib/paged.js'

export interface AuditLogEntry {
  /** The login profile of the person making the change. */
  operatorId: string
  /** What entity was changed: 'client', 'policy', 'policy_dependant', etc. */
  entityType: 'client' | 'policy' | 'policy_dependant' | 'product' | 'staff' | 'agent' | 'system'
  /** The database ID of the entity that was changed. */
  entityId: string
  /** Human-readable description (e.g. "Edited client phone"). */
  action: string
  /** Before/after JSON: { fieldName: { old: ..., new: ... } } or similar. */
  changes: Record<string, { old: unknown; new: unknown }>
  /** Where the change originated (default 'web'). */
  source?: 'web' | 'api' | 'bot' | 'system' | 'import'
  /** Optional context notes. */
  notes?: string
}

/**
 * Write an audit log entry. Called server-side from edit endpoints.
 * Returns true on success, false on failure (failures are logged to console
 * but do not block the primary operation — the edit itself should still succeed).
 */
export async function auditLog(entry: AuditLogEntry): Promise<boolean> {
  const client = serviceClient()
  if (!client) {
    console.error('[audit] Supabase service client not available for audit logging')
    return false
  }

  try {
    const { error } = await client
      .from('audit_log')
      .insert({
        operator_id: entry.operatorId,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        action: entry.action,
        changes: entry.changes,
        source: entry.source ?? 'web',
        notes: entry.notes,
      })

    if (error) {
      console.error('[audit] Failed to write audit log:', error)
      return false
    }
    return true
  } catch (e) {
    console.error('[audit] Exception writing audit log:', e)
    return false
  }
}

/**
 * Fetch audit logs for a specific entity (e.g. all changes to a client).
 * Used by the UI to show change history.
 */
export async function getAuditLogsForEntity(
  entityType: AuditLogEntry['entityType'],
  entityId: string,
): Promise<Array<{
  id: string
  createdAt: string
  operatorId: string
  operatorName?: string
  action: string
  changes: Record<string, { old: unknown; new: unknown }>
  source: string
  notes?: string
}>> {
  const client = serviceClient()
  if (!client) return []

  try {
    const { data, error } = await fetchAllRows(
      () => client
        .from('audit_log')
        .select(`
          id,
          created_at,
          operator_id,
          action,
          changes,
          source,
          notes,
          profiles!audit_log_operator_id_fkey (
            name
          )
        `)
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false }),
      { orderBy: 'id' },
    )

    if (error) {
      console.error('[audit] Failed to fetch audit logs:', error)
      return []
    }

    return (data ?? []).map(row => ({
      id: row.id,
      createdAt: row.created_at,
      operatorId: row.operator_id,
      operatorName: row.profiles?.name,
      action: row.action,
      changes: row.changes,
      source: row.source,
      notes: row.notes,
    }))
  } catch (e) {
    console.error('[audit] Exception fetching audit logs:', e)
    return []
  }
}
