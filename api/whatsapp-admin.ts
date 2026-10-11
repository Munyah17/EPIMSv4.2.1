import type { VercelRequest, VercelResponse } from '@vercel/node'
import { serviceClient, requireSession } from './_lib/sessionAuth.js'
import { sendText } from './_lib/bot/whatsapp.js'

/**
 * POST /api/whatsapp-admin — the WhatsApp Bot page's backend.
 *
 *   { action: 'status' }                 config booleans + bot toggle + counts
 *   { action: 'sessions' }               open wa_sessions rows
 *   { action: 'end_session', id }        kill one session
 *   { action: 'send_test', phone, text } send a real WhatsApp text
 *   { action: 'set_enabled', enabled }   pause/resume the bot (webhook reads it)
 *
 * Admin and super_admin only — a send-anything endpoint on staff keys
 * is fine; on anyone else's it would be a spam rail. Secret VALUES are
 * never returned, only whether each is configured.
 */

const ADMIN_ROLES = ['super_admin', 'admin']
const BOT_SETTINGS_KEY = 'whatsapp_bot'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const admin = serviceClient()
    if (!admin) return res.status(503).json({ error: 'Server is not configured.' })
    if (!(await requireSession(req, admin))) return res.status(401).json({ error: 'Sign-in required.' })

    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const { data: { user } } = await admin.auth.getUser(token)
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).maybeSingle()
    if (!profile?.role || !ADMIN_ROLES.includes(profile.role)) {
      return res.status(403).json({ error: 'Admins only.' })
    }

    const body = req.body ?? {}
    const action = String(body.action ?? '')

    if (action === 'status') {
      const { data: setting } = await admin.from('app_settings').select('value').eq('key', BOT_SETTINGS_KEY).maybeSingle()
      const enabled = (setting?.value as { enabled?: boolean } | null)?.enabled !== false
      const [open, today, botPolicies] = await Promise.all([
        admin.from('wa_sessions').select('id', { count: 'exact', head: true }).eq('is_expired', false),
        admin.from('wa_sessions').select('id', { count: 'exact', head: true })
          .gte('created_at', new Date(Date.now() - 24 * 3600e3).toISOString()),
        admin.from('policies').select('id', { count: 'exact', head: true }).eq('source', 'whatsapp_chatbot'),
      ])
      return res.status(200).json({
        enabled,
        configured: {
          accessToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
          phoneNumberId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
          verifyToken: !!process.env.WHATSAPP_VERIFY_TOKEN,
          appSecret: !!process.env.WHATSAPP_APP_SECRET,
          paynow: !!(process.env.PAYNOW_INTEGRATION_ID && process.env.PAYNOW_INTEGRATION_KEY),
          ecocash: !!(process.env.EIP_USERNAME && process.env.EIP_PASSWORD),
          graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
        },
        counts: {
          openSessions: open.count ?? 0,
          sessions24h: today.count ?? 0,
          policiesViaBot: botPolicies.count ?? 0,
        },
      })
    }

    if (action === 'sessions') {
      const { data } = await admin.from('wa_sessions')
        .select('id, phone_number, contact_type, state, note, created_at')
        .eq('is_expired', false).order('created_at', { ascending: false }).limit(50)
      return res.status(200).json({ sessions: data ?? [] })
    }

    if (action === 'end_session') {
      const id = String(body.id ?? '')
      if (!id) return res.status(400).json({ error: 'id is required.' })
      await admin.from('wa_sessions').delete().eq('id', id)
      return res.status(200).json({ ok: true })
    }

    if (action === 'send_test') {
      const phone = String(body.phone ?? '').replace(/\D/g, '')
      const text = String(body.text ?? '').trim() || 'Motions WhatsApp Bot — test message from the portal.'
      if (!/^\d{10,15}$/.test(phone)) return res.status(400).json({ error: 'Enter the number in international format, e.g. 263775668334.' })
      await sendText(phone, text)
      return res.status(200).json({ ok: true })
    }

    if (action === 'set_enabled') {
      const enabled = body.enabled === true
      await admin.from('app_settings').upsert({ key: BOT_SETTINGS_KEY, value: { enabled } }, { onConflict: 'key' })
      return res.status(200).json({ ok: true, enabled })
    }

    return res.status(400).json({ error: 'Unknown action.' })
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
