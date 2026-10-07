import type { VercelRequest } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Shared "a real signed-in user is asking" gate for the endpoints that
 * spend money or touch a third party on our account: send-email (our
 * Microsoft 365 / SMTP), gateway-proxy's SMS action (our Afrosoft key),
 * ecocash-instant (our merchant credentials), paynow (our integrations),
 * and the /api/ai routes (paid Groq/Google quota). Before this existed all
 * of them answered the anonymous internet — an open mail relay and an SMS
 * sender funded by us.
 *
 * The bar is deliberately "any active session", not a staff role: a
 * logged-in policyholder legitimately reaches some of these (paying a
 * premium online from the portal, filing a ticket) and actions they take
 * can fire notifications in their name. What this stops is the caller who
 * has no account at all.
 */

export function serviceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return null
  return createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

export async function requireSession(req: VercelRequest, admin: SupabaseClient): Promise<boolean> {
  const authHeader = req.headers.authorization
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  if (!token) return false
  const { data: { user }, error } = await admin.auth.getUser(token)
  if (error || !user) return false
  // A deactivated account's JWT still verifies until it expires -- the
  // profile's active flag is the real answer.
  const { data: profile } = await admin.from('profiles').select('active').eq('id', user.id).maybeSingle()
  return profile?.active === true
}
