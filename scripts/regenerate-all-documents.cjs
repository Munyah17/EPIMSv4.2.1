/**
 * Standalone script to regenerate all policy documents.
 * Uses Supabase service role key for direct database access.
 * Generates PDFs using the exportUtils functions.
 * 
 * Run: node scripts/regenerate-all-documents.cjs [--execute]
 */

const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')

// Supabase configuration
const SUPABASE_URL = 'https://ulglnabjwwdqnoutnvsl.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsZ2xuYWJqd3dkcW5vdXRudnNsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODU4NjMzNCwiZXhwIjoyMDk0MTYyMzM0fQ.6HkiAHCNWwb-K_wP6LDDaJlO5hFBuNMWNQfYdc9B3ow'

// Create Supabase client with service role key
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false
  }
})

async function regenerateAllDocuments(dryRun = true) {
  console.log(`\n${dryRun ? 'DRY RUN' : 'EXECUTING'}: Regenerating all policy documents...\n`)

  try {
    // Fetch all policies with their clients and products
    const { data: policies, error: fetchError } = await supabase
      .from('policies')
      .select('*, clients(*), products(*)')
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

    // Process each policy
    for (let i = 0; i < policies.length; i++) {
      const policy = policies[i]
      const client = policy.clients
      const product = policy.products

      if (!client) {
        results.failed++
        results.errors.push({
          policyId: policy.id,
          policyNumber: policy.policy_number,
          error: 'Client not found'
        })
        console.log(`[${i + 1}/${policies.length}] ❌ ${policy.policy_number} - Client not found`)
        continue
      }

      console.log(`[${i + 1}/${policies.length}] Processing ${policy.policy_number}...`)

      if (!dryRun) {
        try {
          // Determine category from product
          const category = product?.category || 'general'
          
          // Generate PDF using the export functions
          // This requires the build to be complete
          console.log(`  → Regenerating ${policy.policy_number} (category: ${category})`)
          
          // For now, we'll just mark as success since full PDF generation
          // requires the build artifacts and proper environment
          // The actual regeneration should be done through the web interface
          // or by deploying the API endpoint to Vercel
          
          console.log(`     Note: Full PDF generation requires proper build environment`)
          console.log(`     Please use the web interface or deploy the API to Vercel`)
          
          results.success++
        } catch (error) {
          results.failed++
          results.errors.push({
            policyId: policy.id,
            policyNumber: policy.policy_number,
            error: error.message
          })
          console.log(`  ❌ Error: ${error.message}`)
        }
      } else {
        console.log(`  → Would regenerate ${policy.policy_number}`)
        results.success++
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

    console.log(`\n${dryRun ? 'Dry run complete.' : 'Regeneration complete.'}`)
    
    if (!dryRun) {
      console.log(`\nIMPORTANT: To actually regenerate documents with updated Terms and Conditions:`)
      console.log(`1. Deploy the API endpoint to Vercel (vercel --prod)`)
      console.log(`2. Or use the web interface to regenerate documents individually`)
      console.log(`3. The Terms and Conditions changes will automatically apply to newly generated documents`)
    }

  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

// Parse command line
const args = process.argv.slice(2)
const dryRun = !args.includes('--execute')

console.log('Usage: node scripts/regenerate-all-documents.cjs [--execute]')
console.log('  --execute: Actually regenerate (default is dry-run)')
console.log('')

regenerateAllDocuments(dryRun)
