/** Groq-backed AI scoring, called via Netlify functions so the API key never reaches the browser. */

export async function scoreLead(input: { name: string; source: string; productInterest: string; notes?: string }): Promise<{ score: number; reasoning: string }> {
  try {
    const res = await fetch('/api/score-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) return { score: 50, reasoning: 'AI scoring unavailable, default score used.' }
    return await res.json()
  } catch {
    return { score: 50, reasoning: 'AI scoring unavailable, default score used.' }
  }
}

export interface PreLossAiContext {
  subjectType: string
  cropType?: string
  cropPopulation?: string
  registrationNumber?: string
  vehicleMakeModel?: string
  existingDamage?: string
  recordedAt?: string
}

export interface PostLossAiContext {
  descriptionOfLoss?: string
  farmerStatement?: string
  assessorComments?: string
  cropStage?: string
}

export async function scoreClaimFraud(input: {
  claimType: string; amount: number; coverAmount: number; dateOfEvent: string
  policyStartDate: string; dateSubmitted: string; description: string; priorClaimsOnPolicy: number
  preLossAssessment?: PreLossAiContext
  postLossAssessment?: PostLossAiContext
}): Promise<{ score: number; signals: string[]; insights: string[]; reasoning: string }> {
  try {
    const res = await fetch('/api/score-claim-fraud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) return { score: 20, signals: [], insights: [], reasoning: 'AI fraud scoring unavailable, default score used.' }
    const body = await res.json()
    return { score: body.score ?? 20, signals: body.signals ?? [], insights: body.insights ?? [], reasoning: body.reasoning ?? '' }
  } catch {
    return { score: 20, signals: [], insights: [], reasoning: 'AI fraud scoring unavailable, default score used.' }
  }
}
