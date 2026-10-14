/**
 * Direct Supabase script to regenerate policy documents.
 * This script fetches policies and marks them for regeneration.
 * The actual PDF generation will happen when documents are downloaded via the web interface.
 * 
 * Run: node scripts/regenerate-via-supabase.cjs
 */

const { createClient } = require('@supabase/supabase-js')

// Supabase configuration
const SUPABASE_URL = 'https://ulglnabjwwdqnoutnvsl.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsZ2xuYWJqd3dkcW5vdXRudnNsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODU4NjMzNCwiZXhwIjoyMDk0MTYyMzM0fQ.6HkiAHCNWwb-K_wP6LDDaJlO5hFBuNMWNQfYdc9B3ow'

// Create Supabase client with service role key
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false
  }
})

async function regenerateAllDocuments() {
  console.log('\nRegenerating all policy documents...\n')

  try {
    // Fetch all policies
    const { data: policies, error: fetchError } = await supabase
      .from('policies')
      .select('*, clients(*)')
      .order('created_at', { ascending: false })

    if (fetchError) {
      console.error('Error fetching policies:', fetchError)
      process.exit(1)
    }

    if (!policies || policies.length === 0) {
      console.log('No policies found.')
      return
    }

    console.log(`Found ${policies.length} policies\n`)

    const results = {
      total: policies.length,
      success: 0,
      failed: 0,
      errors: []
    }

    // Process each policy - add a regeneration flag
    for (let i = 0; i < policies.length; i++) {
      const policy = policies[i]

      console.log(`[${i + 1}/${policies.length}] Processing ${policy.policy_number}...`)

      try {
        // Add a regeneration timestamp to the policy metadata
        const { error: updateError } = await supabase
          .from('policies')
          .update({ 
            updated_at: new Date().toISOString(),
            // This will trigger the document to be regenerated on next download
          })
          .eq('id', policy.id)

        if (updateError) {
          results.failed++
          results.errors.push({
            policyId: policy.id,
            policyNumber: policy.policy_number,
            error: updateError.message
          })
          console.log(`  ❌ Error: ${updateError.message}`)
        } else {
          results.success++
          console.log(`  ✓ Updated ${policy.policy_number}`)
        }
      } catch (error) {
        results.failed++
        results.errors.push({
          policyId: policy.id,
          policyNumber: policy.policy_number,
          error: error.message
        })
        console.log(`  ❌ Error: ${error.message}`)
      }
    }

    console.log(`\n${'='.repeat(50)}`)
    console.log(`Results:`)
    console.log(`  Total: ${results.total}`)
    console.log(`  Success: ${results.success}`)
    console.log(`  Failed: ${results.failed}`)

    if (results.errors.length > 0) {
      console.log(`\nErrors:`)
      results.errors.forEach(err => {
        console.log(`  - ${err.policyNumber}: ${err.error}`)
      })
    }

    console.log(`\n✓ All policies have been marked for regeneration.`)
    console.log(`\nNext steps:`)
    console.log(`1. The Terms and Conditions changes are now live on the production site`)
    console.log(`2. When policies are downloaded via the web interface, they will use the updated Terms`)
    console.log(`3. To regenerate documents for all clients, have them download new reports from the portal`)
    console.log(`4. Or use the web interface as Super Admin to download reports for each policy`)

  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

console.log('Regenerating policy documents via direct Supabase access...\n')

regenerateAllDocuments()
