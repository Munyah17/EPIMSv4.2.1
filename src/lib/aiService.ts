/** Groq-backed AI scoring, called via Netlify functions so the API key never reaches the browser. */

export async function scoreLead(input: { name: string; source: string; productInterest: string; notes?: string }): Promise<{ score: number; reasoning: string }> {
  try {
    const res = await fetch('/.netlify/functions/score-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) return { score: 50, reasoning: 'AI scoring unavailable — default score used.' }
    return await res.json()
  } catch {
    return { score: 50, reasoning: 'AI scoring unavailable — default score used.' }
  }
}

export async function scoreClaimFraud(input: {
  claimType: string; amount: number; coverAmount: number; dateOfEvent: string
  policyStartDate: string; dateSubmitted: string; description: string; priorClaimsOnPolicy: number
}): Promise<{ score: number; signals: string[]; reasoning: string }> {
  try {
    const res = await fetch('/.netlify/functions/score-claim-fraud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) return { score: 20, signals: [], reasoning: 'AI fraud scoring unavailable — default score used.' }
    return await res.json()
  } catch {
    return { score: 20, signals: [], reasoning: 'AI fraud scoring unavailable — default score used.' }
  }
}
