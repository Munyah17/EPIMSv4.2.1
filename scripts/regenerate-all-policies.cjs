/**
 * Direct policy document regeneration script.
 * Uses Supabase service role and generates PDFs directly.
 */

const { createClient } = require('@supabase/supabase-js')

// Configuration
const SUPABASE_URL = 'https://ulglnabjwwdqnoutnvsl.supabase.co'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsZ2xuYWJqd3dkcW5vdXRudnNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1ODYzMzQsImV4cCI6MjA5NDE2MjMzNH0.al_Td23ySOVVFpkWISCmW7Yl3uuDK6MKQGKYrr9RviM'
const SERVICE_ROLE_KEY = 'sbp_fc5363faf4d4358419358b1bf81ced64ddab8707'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

async function regenerateAllPolicies() {
  console.log('Fetching all policies...')

  const { data: policies, error: fetchError } = await supabase
    .from('policies')
    .select('*, clients(*)')

  if (fetchError) {
    console.error('Failed to fetch policies:', fetchError)
    process.exit(1)
  }

  if (!policies || policies.length === 0) {
    console.log('No policies found.')
    process.exit(0)
  }

  console.log(`Found ${policies.length} policies.`)
  console.log('\nThis will regenerate ALL policy documents with the updated terms and conditions.')
  console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...')

  await new Promise(resolve => setTimeout(resolve, 5000))

  console.log('\nStarting regeneration...')

  let success = 0
  let failed = 0
  const errors = []

  for (const policy of policies) {
    try {
      const client = policy.clients
      if (!client) {
        failed++
        errors.push({ policyNumber: policy.policy_number, error: 'Client not found' })
        console.log(`❌ ${policy.policy_number}: Client not found`)
        continue
      }

      // Generate PDF by calling the API endpoint
      const response = await fetch('https://portal.motions.co.zw/api/regenerate-policy-documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          category: policy.category || 'general',
          status: policy.status,
          dryRun: false,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        failed++
        errors.push({ policyNumber: policy.policy_number, error: errorText.substring(0, 100) })
        console.log(`❌ ${policy.policy_number}: ${errorText.substring(0, 100)}`)
        continue
      }

      const result = await response.json()
      success++
      console.log(`✓ ${policy.policy_number}: ${result.message}`)

    } catch (err) {
      failed++
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      errors.push({ policyNumber: policy.policy_number, error: errorMsg })
      console.log(`❌ ${policy.policy_number}: ${errorMsg}`)
    }
  }

  console.log('\n=== Summary ===')
  console.log(`Total: ${policies.length}`)
  console.log(`Success: ${success}`)
  console.log(`Failed: ${failed}`)

  if (errors.length > 0) {
    console.log('\nErrors:')
    errors.forEach(err => {
      console.log(`  - ${err.policyNumber}: ${err.error}`)
    })
  }

  process.exit(failed > 0 ? 1 : 0)
}

regenerateAllPolicies()
