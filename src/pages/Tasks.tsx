import { useState, useEffect, useMemo, useCallback } from 'react'
import type { ToastMessage, Task, TaskMilestone, TaskUpdate, TaskPriority, AppUser } from '../types'
import { db } from '../lib/db'
import { formatDate, formatDateTime } from '../lib/dateUtils'
import { useAuth } from '../contexts/AuthContext'
import { notifyPhone } from '../lib/notify'
import ValidationSummary, { MissingField, invalidClass, fieldId } from '../components/ui/ValidationSummary'

interface Props {
  showToast: (type: ToastMessage['type'], message: string) => void
}

const PRIORITY_PILL: Record<TaskPriority, string> = {
  low: 'pill-gray',
  medium: 'pill-pending',
  high: 'pill-caution',
  urgent: 'pill-cancelled',
}
const STATUS_PILL: Record<Task['status'], string> = {
  open: 'pill-pending',
  in_progress: 'pill-caution',
  completed: 'pill-active',
  cancelled: 'pill-cancelled',
}
const STATUS_LABEL: Record<Task['status'], string> = {
  open: 'open', in_progress: 'in progress', completed: 'completed', cancelled: 'cancelled',
}

type Filter = 'all' | 'mine' | 'open' | 'completed' | 'overdue'

const isOverdue = (t: Task) =>
  t.status !== 'completed' && t.status !== 'cancelled' && !!t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10)

/** Team task board — Super Admin issues work, staff tick milestones and
 *  post progress live, and the leaderboard turns completion, rate and
 *  lead time into the Staff of the Month pick. The three tables are on
 *  supabase_realtime, so a tick on one screen moves every screen. */
export default function Tasks({ showToast }: Props) {
  const { user } = useAuth()
  const isSuper = user?.role === 'super_admin'
  const [tasks, setTasks] = useState<Task[]>([])
  const [milestones, setMilestones] = useState<TaskMilestone[]>([])
  const [updates, setUpdates] = useState<TaskUpdate[]>([])
  const [staffList, setStaffList] = useState<AppUser[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>(isSuper ? 'all' : 'mine')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [reassigning, setReassigning] = useState<Task | null>(null)
  const [updateDraft, setUpdateDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    Promise.all([db.tasks.list(), db.taskMilestones.list(), db.taskUpdates.list()])
      .then(([t, m, u]) => {
        if (t.error) showToast('error', t.error)
        setTasks(t.data ?? [])
        setMilestones(m.data ?? [])
        setUpdates(u.data ?? [])
      })
      .finally(() => setLoading(false))
  }, [showToast])

  useEffect(() => {
    setLoading(true)
    load()
    db.staff.list().then(({ data }) => setStaffList((data ?? []).filter(s => s.active)))
    // Realtime — a milestone ticked anywhere repaints every dashboard.
    const off1 = db.subscribeToTable('tasks', load)
    const off2 = db.subscribeToTable('task_milestones', load)
    const off3 = db.subscribeToTable('task_updates', load)
    return () => { off1(); off2(); off3() }
  }, [load])

  const msFor = useCallback((taskId: string) =>
    milestones.filter(m => m.taskId === taskId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    [milestones])
  const upsFor = useCallback((taskId: string) =>
    updates.filter(u => u.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [updates])

  const filtered = useMemo(() => tasks.filter(t => {
    if (filter === 'mine') return t.assigneeId === user?.id
    if (filter === 'open') return t.status === 'open' || t.status === 'in_progress'
    if (filter === 'completed') return t.status === 'completed'
    if (filter === 'overdue') return isOverdue(t)
    return t.status !== 'cancelled'
  }), [tasks, filter, user?.id])

  // ── Leaderboard ──────────────────────────────────────────────────
  const board = useMemo(() => {
    const byAssignee = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.assigneeName || t.status === 'cancelled') continue
      const arr = byAssignee.get(t.assigneeName) ?? []
      arr.push(t); byAssignee.set(t.assigneeName, arr)
    }
    return [...byAssignee.entries()].map(([name, arr]) => {
      const done = arr.filter(t => t.status === 'completed')
      const leadDays = done
        .map(t => (new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime()) / 86400000)
        .filter(d => d >= 0)
      const onTime = done.filter(t => !t.dueDate || t.completedAt!.slice(0, 10) <= t.dueDate)
      return {
        name,
        assigned: arr.length,
        completed: done.length,
        rate: arr.length ? Math.round(done.length * 100 / arr.length) : 0,
        avgLead: leadDays.length ? leadDays.reduce((a, b) => a + b, 0) / leadDays.length : null,
        onTimePct: done.length ? Math.round(onTime.length * 100 / done.length) : 0,
        open: arr.filter(t => t.status === 'open' || t.status === 'in_progress').length,
      }
    }).sort((a, b) => b.completed - a.completed || b.rate - a.rate || (a.avgLead ?? 999) - (b.avgLead ?? 999))
  }, [tasks])

  const staffOfMonth = useMemo(() => {
    const month = new Date().toISOString().slice(0, 7)
    const thisMonth = tasks.filter(t => t.status === 'completed' && t.completedAt?.startsWith(month))
    const counts = new Map<string, number>()
    for (const t of thisMonth) counts.set(t.assigneeName, (counts.get(t.assigneeName) ?? 0) + 1)
    let best: { name: string; count: number } | null = null
    for (const [name, count] of counts) if (!best || count > best.count) best = { name, count }
    return best
  }, [tasks])

  // ── Actions ──────────────────────────────────────────────────────
  const toggleMilestone = async (m: TaskMilestone) => {
    setBusyId(m.id)
    const { error } = await db.taskMilestones.toggle(m.id, !m.done, user?.name ?? 'staff')
    setBusyId(null)
    if (error) { showToast('error', error); return }
    setMilestones(prev => prev.map(x => x.id === m.id
      ? { ...x, done: !m.done, doneAt: !m.done ? new Date().toISOString() : undefined, doneByName: !m.done ? user?.name : undefined }
      : x))
  }

  const completeTask = async (t: Task) => {
    setBusyId(t.id)
    const { error } = await db.tasks.markComplete(t.id)
    setBusyId(null)
    if (error) { showToast('error', error); return }
    showToast('success', `"${t.title}" marked complete.`)
    load()
  }

  const postUpdate = async (t: Task) => {
    const body = updateDraft.trim()
    if (!body) return
    setBusyId(`upd-${t.id}`)
    const { error } = await db.taskUpdates.post({ taskId: t.id, authorId: user?.id, authorName: user?.name ?? 'staff', body })
    setBusyId(null)
    if (error) { showToast('error', error); return }
    setUpdateDraft('')
    load()
  }

  /** The assignee's phone pings the moment a task lands — no waiting
   *  for them to open the app. */
  const smsAssignee = (assigneeId: string | undefined, title: string, verb: 'assigned' | 'reassigned') => {
    const phone = staffList.find(s => s.id === assigneeId)?.phone
    if (phone) notifyPhone(phone, `You were ${verb} a task: "${title}". Open Tasks to see the milestones.`, 'general', `task:${title.slice(0, 20)}`)
  }

  const createTask = async (input: { title: string; description: string; priority: TaskPriority; assigneeId: string; dueDate: string; milestones: string[] }) => {
    const assignee = staffList.find(s => s.id === input.assigneeId)
    setSaving(true)
    const { data, error } = await db.tasks.create({
      title: input.title, description: input.description, priority: input.priority,
      assigneeId: input.assigneeId || undefined, assigneeName: assignee?.name ?? '',
      dueDate: input.dueDate || undefined,
      createdBy: user?.id, createdByName: user?.name,
      milestones: input.milestones,
    })
    setSaving(false)
    if (error || !data) { showToast('error', error ?? 'Failed to create the task.'); return }
    setShowCreate(false)
    showToast('success', `Task "${data.title}" issued to ${data.assigneeName || 'the team'}.`)
    smsAssignee(input.assigneeId, data.title, 'assigned')
    load()
  }

  const reassign = async (t: Task, assigneeId: string) => {
    const assignee = staffList.find(s => s.id === assigneeId)
    setBusyId(t.id)
    const { error } = await db.tasks.update(t.id, { assigneeId, assigneeName: assignee?.name ?? '' })
    setBusyId(null)
    if (error) { showToast('error', error); return }
    setReassigning(null)
    showToast('success', `"${t.title}" reassigned to ${assignee?.name ?? '—'}.`)
    smsAssignee(assigneeId, t.title, 'reassigned')
    load()
  }

  const cancelTask = async (t: Task) => {
    if (!window.confirm(`Cancel "${t.title}"? Its milestones and updates stay on record.`)) return
    const { error } = await db.tasks.update(t.id, { status: 'cancelled' })
    if (error) { showToast('error', error); return }
    showToast('success', `"${t.title}" cancelled.`)
    load()
  }

  const deleteTask = async (t: Task) => {
    if (!window.confirm(`Delete "${t.title}" permanently — milestones and updates go with it?`)) return
    const { error } = await db.tasks.remove(t.id)
    if (error) { showToast('error', error); return }
    showToast('success', 'Task deleted.')
    load()
  }

  const mine = tasks.filter(t => t.assigneeId === user?.id && (t.status === 'open' || t.status === 'in_progress'))
  const overdueCount = tasks.filter(isOverdue).length
  const monthDone = tasks.filter(t => t.status === 'completed' && t.completedAt?.startsWith(new Date().toISOString().slice(0, 7))).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── Stats ── */}
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value">{mine.length}</div><div className="stat-label">My Open Tasks</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: overdueCount ? 'var(--danger)' : undefined }}>{overdueCount}</div><div className="stat-label">Overdue (team)</div></div>
        <div className="stat-card"><div className="stat-value">{tasks.filter(t => t.status === 'open' || t.status === 'in_progress').length}</div><div className="stat-label">Open (team)</div></div>
        <div className="stat-card"><div className="stat-value">{monthDone}</div><div className="stat-label">Completed This Month</div></div>
      </div>

      {/* ── Leaderboard + Staff of the Month ── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Staff Task Leaderboard</span>
          {staffOfMonth && (
            <span className="pill pill-active" title="Most tasks completed this calendar month">
              Staff of the Month: {staffOfMonth.name} ({staffOfMonth.count})
            </span>
          )}
        </div>
        {board.length === 0 ? (
          <div className="empty-state">No tasks on record yet — the leaderboard fills as staff complete work.</div>
        ) : (
          <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr><th>#</th><th>Staff Member</th><th>Assigned</th><th>Done</th><th>Completion Rate</th><th>Avg Lead Time</th><th>On-Time</th><th>Open</th></tr>
              </thead>
              <tbody>
                {board.map((b, i) => (
                  <tr key={b.name} style={i === 0 ? { fontWeight: 600 } : undefined}>
                    <td>{i + 1}{i === 0 ? ' ★' : ''}</td>
                    <td>{b.name}</td>
                    <td>{b.assigned}</td>
                    <td>{b.completed}</td>
                    <td>{b.rate}%</td>
                    <td>{b.avgLead != null ? `${b.avgLead.toFixed(1)}d` : '—'}</td>
                    <td>{b.completed ? `${b.onTimePct}%` : '—'}</td>
                    <td>{b.open}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Task board ── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Tasks</span>
          {isSuper && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>＋ Issue Task</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {(['all', 'mine', 'open', 'overdue', 'completed'] as Filter[]).map(f => (
            <button key={f} className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'mine' ? 'Mine' : f === 'open' ? 'Open' : f === 'overdue' ? `Overdue${overdueCount ? ` (${overdueCount})` : ''}` : 'Completed'}
            </button>
          ))}
        </div>
        {loading ? (
          <div className="empty-state">Loading tasks…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {filter === 'mine' ? 'Nothing assigned to you right now.' : 'No tasks in this view.'}
          </div>
        ) : (
          <div className="tbl-scroll">
            <table className="table">
              <thead>
                <tr><th>Task</th><th>Priority</th><th>Assignee</th><th>Progress</th><th>Due</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {filtered.map(t => {
                  const ms = msFor(t.id)
                  const ups = upsFor(t.id)
                  const isMine = t.assigneeId === user?.id
                  const open = expanded === t.id
                  return (
                    <>
                      <tr key={t.id} style={{ cursor: 'pointer', opacity: t.status === 'cancelled' ? 0.55 : 1 }}
                        onClick={() => setExpanded(open ? null : t.id)}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{t.title}</div>
                          {t.description && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t.description.length > 70 ? `${t.description.slice(0, 70)}…` : t.description}</div>}
                        </td>
                        <td><span className={`pill ${PRIORITY_PILL[t.priority]}`}>{t.priority}</span></td>
                        <td>{t.assigneeName || '—'}{isMine && <span className="pill pill-caution" style={{ marginLeft: 4 }}>you</span>}</td>
                        <td style={{ minWidth: 110 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--surface2, #E2E8F0)' }}>
                              <div style={{ width: `${t.status === 'completed' ? 100 : t.progress}%`, height: '100%', borderRadius: 3, background: t.status === 'completed' ? 'var(--success)' : 'var(--accent)', transition: 'width .3s' }} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                              {ms.length ? `${ms.filter(m => m.done).length}/${ms.length}` : `${t.status === 'completed' ? 100 : t.progress}%`}
                            </span>
                          </div>
                        </td>
                        <td>
                          {t.dueDate ? formatDate(t.dueDate) : '—'}
                          {isOverdue(t) && <span className="pill pill-cancelled" style={{ marginLeft: 4 }}>overdue</span>}
                        </td>
                        <td><span className={`pill ${STATUS_PILL[t.status]}`}>{STATUS_LABEL[t.status]}</span></td>
                        <td onClick={e => e.stopPropagation()}>
                          <div className="action-btns">
                            {isSuper && t.status !== 'completed' && t.status !== 'cancelled' && (
                              <>
                                <button className="btn btn-ghost btn-sm" onClick={() => setReassigning(t)}>Reassign</button>
                                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => void cancelTask(t)}>Cancel</button>
                              </>
                            )}
                            {isSuper && (
                              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => void deleteTask(t)}>Delete</button>
                            )}
                            {isMine && ms.length === 0 && (t.status === 'open' || t.status === 'in_progress') && (
                              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }}
                                disabled={busyId === t.id} onClick={() => void completeTask(t)}>
                                Mark Complete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr key={`${t.id}-detail`}>
                          <td colSpan={7} style={{ background: 'var(--surface2, rgba(148,163,184,.08))', padding: '12px 16px' }}>
                            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                              {/* Milestones — the assignee's checklist */}
                              <div style={{ flex: 1, minWidth: 260 }}>
                                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>Milestones</div>
                                {ms.length === 0 ? (
                                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>No milestones — the task completes with one action.</div>
                                ) : ms.map(m => (
                                  <label key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, marginBottom: 6, cursor: isMine || isSuper ? 'pointer' : 'default', opacity: busyId === m.id ? 0.5 : 1 }}>
                                    <input type="checkbox" checked={m.done} disabled={(!isMine && !isSuper) || busyId === m.id || t.status === 'cancelled'}
                                      onChange={() => void toggleMilestone(m)} />
                                    <span style={{ textDecoration: m.done ? 'line-through' : 'none', color: m.done ? 'var(--muted)' : 'var(--text)' }}>
                                      {m.label}
                                      {m.done && m.doneByName && <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)' }}>✓ {m.doneByName}{m.doneAt ? ` · ${formatDateTime(m.doneAt)}` : ''}</span>}
                                    </span>
                                  </label>
                                ))}
                              </div>
                              {/* Updates feed — realtime progress notes */}
                              <div style={{ flex: 1, minWidth: 260 }}>
                                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>Updates</div>
                                {ups.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No updates yet.</div>}
                                {ups.slice(-6).map(u => (
                                  <div key={u.id} style={{ fontSize: 12, marginBottom: 6 }}>
                                    <span style={{ fontWeight: 500 }}>{u.authorName}</span>
                                    <span style={{ color: 'var(--muted)', fontSize: 10 }}> · {formatDateTime(u.createdAt)}</span>
                                    <div>{u.body}</div>
                                  </div>
                                ))}
                                {(isMine || isSuper) && t.status !== 'cancelled' && t.status !== 'completed' && (
                                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                                    <input className="form-control" style={{ flex: 1 }} placeholder="Post a progress update…"
                                      value={updateDraft} onChange={e => setUpdateDraft(e.target.value)}
                                      onKeyDown={e => { if (e.key === 'Enter') void postUpdate(t) }} />
                                    <button className="btn btn-primary btn-sm" disabled={busyId === `upd-${t.id}` || !updateDraft.trim()}
                                      onClick={() => void postUpdate(t)}>Post</button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <NewTaskModal
          staffList={staffList}
          saving={saving}
          onClose={() => setShowCreate(false)}
          onSave={createTask}
        />
      )}

      {reassigning && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h3>Reassign — {reassigning.title}</h3>
              <button className="modal-close" onClick={() => setReassigning(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>New assignee</label>
                <select className="form-control" defaultValue={reassigning.assigneeId ?? ''} id="reassign-select">
                  <option value="">— unassigned —</option>
                  {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setReassigning(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busyId === reassigning.id}
                onClick={() => reassign(reassigning, (document.getElementById('reassign-select') as HTMLSelectElement).value)}>
                Reassign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Super Admin issues a task: title, assignee, priority, due date and
 *  the milestones that define "done" — one per line. */
function NewTaskModal({ staffList, saving, onClose, onSave }: {
  staffList: AppUser[]
  saving: boolean
  onClose: () => void
  onSave: (input: { title: string; description: string; priority: TaskPriority; assigneeId: string; dueDate: string; milestones: string[] }) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [assigneeId, setAssigneeId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [milestonesText, setMilestonesText] = useState('')
  const [attempted, setAttempted] = useState(false)

  const missing: MissingField[] = []
  if (!title.trim()) missing.push({ key: 'title', label: 'Title' })
  if (!assigneeId) missing.push({ key: 'assignee', label: 'Assignee' })

  const handleSave = () => {
    setAttempted(true)
    if (missing.length) return
    onSave({
      title: title.trim(), description: description.trim(), priority, assigneeId,
      dueDate, milestones: milestonesText.split('\n'),
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h3>Issue Task</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ValidationSummary missing={missing} attempted={attempted} />
          <div className="form-group" id={fieldId('title')}>
            <label>Title *</label>
            <input className={invalidClass(missing, attempted, 'title')} value={title} onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Reconcile October premium receipts" />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea className="form-control" rows={2} value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What success looks like…" />
          </div>
          <div className="form-row">
            <div className="form-group" id={fieldId('assignee')}>
              <label>Assignee *</label>
              <select className={invalidClass(missing, attempted, 'assignee')} value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
                <option value="">Pick staff member…</option>
                {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Priority</label>
              <select className="form-control" value={priority} onChange={e => setPriority(e.target.value as TaskPriority)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className="form-group">
              <label>Due date</label>
              <input type="date" className="form-control" value={dueDate} onChange={e => setDueDate(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>Milestones — one per line; the assignee ticks each as it lands</label>
            <textarea className="form-control" rows={4} value={milestonesText} onChange={e => setMilestonesText(e.target.value)}
              placeholder={'Pull the receipts report\nCross-check against bank statement\nEmail the reconciliation to finance'} />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Leave empty for a single-action task — the assignee marks it complete in one step.
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Issuing…' : 'Issue Task'}
          </button>
        </div>
      </div>
    </div>
  )
}
