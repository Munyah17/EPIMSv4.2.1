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
