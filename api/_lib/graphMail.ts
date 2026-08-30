/**
 * Sending mail through Microsoft 365, using Graph rather than SMTP.
 *
 * Microsoft has been retiring Basic Authentication across Exchange Online,
 * and SMTP client submission was the last thing still exempt. Building on
 * a username and password that Microsoft is switching off is not worth
 * doing, so this uses the app-only Graph flow instead: a client secret we
 * can rotate, no mailbox password anywhere, and it keeps working with MFA
 * and conditional access in force.
 *
 * It also removes a limitation SMTP forced on us. Authenticating as one
 * mailbox meant every message went out from that account and the real
 * desk (claims@, underwriting@ …) could only be a Reply-To. With Graph,
 * each role mailbox genuinely sends as itself and the message lands in
 * that mailbox's Sent Items.
 *
 * Configure on the server:
 *   MS_TENANT_ID       directory (tenant) ID of the Entra app registration
 *   MS_CLIENT_ID       application (client) ID
 *   MS_CLIENT_SECRET   client secret value
 *
 * The app registration needs the Mail.Send APPLICATION permission with
 * admin consent granted. Scope it with an Exchange Application Access
 * Policy so it can only send as the role mailboxes -- without that, the
 * permission covers every mailbox in the tenant, and a leaked secret could
 * send as anyone.
 */

export function graphConfigured(): boolean {
  return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET)
}

interface CachedToken { value: string; expiresAt: number }
let cached: CachedToken | null = null

/** Client-credentials token, reused until a minute before it expires
 *  rather than fetched per message. */
async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.value

  const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.MS_CLIENT_ID!,
      client_secret: process.env.MS_CLIENT_SECRET!,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  })

  const text = await res.text()
  if (!res.ok) {
    // Microsoft's own wording names the fix -- expired secret, missing
    // admin consent, wrong tenant -- far better than any paraphrase.
    throw new Error(`Microsoft rejected the credentials (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }

  const body = JSON.parse(text) as { access_token: string; expires_in: number }
  cached = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(0, (body.expires_in - 60)) * 1000,
  }
  return cached.value
}

export interface GraphMail {
  /** The mailbox this is sent AS. Must exist in the tenant and be covered
   *  by the application access policy. */
  from: string
  fromName?: string
  to: string
  cc?: string
  replyTo?: string
  subject: string
  text: string
  attachmentBase64?: string
  attachmentFilename?: string
}

/** Comma/semicolon separated addresses -> Graph recipient objects. */
function recipients(list?: string) {
  return (list ?? '')
    .split(/[,;]/)
    .map(a => a.trim())
    .filter(Boolean)
    .map(address => ({ emailAddress: { address } }))
}

export async function sendViaGraph(mail: GraphMail): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const token = await getAccessToken()

    const message: Record<string, unknown> = {
      subject: mail.subject,
      body: { contentType: 'Text', content: mail.text },
      toRecipients: recipients(mail.to),
    }
    const cc = recipients(mail.cc)
    if (cc.length) message.ccRecipients = cc
    const replyTo = recipients(mail.replyTo)
    if (replyTo.length) message.replyTo = replyTo
    if (mail.attachmentBase64 && mail.attachmentFilename) {
      message.attachments = [{
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: mail.attachmentFilename,
        contentBytes: mail.attachmentBase64,
      }]
    }

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mail.from)}/sendMail`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // Kept in the sending mailbox's Sent Items, so there is a record of
        // what the system sent on a desk a person can actually open.
        body: JSON.stringify({ message, saveToSentItems: true }),
      },
    )

    // A successful sendMail returns 202 with an empty body.
    if (res.status === 202) return { ok: true }

    const detail = await res.text()
    return { ok: false, error: `Graph refused the send (HTTP ${res.status}): ${detail.slice(0, 300)}` }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
