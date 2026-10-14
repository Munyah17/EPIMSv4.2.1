/**
 * Standalone script to regenerate all policy documents.
 * Uses Supabase service role key for direct database access.
 * Calls the production API to regenerate documents.
 * 
 * Run: node scripts/regenerate-all-documents.cjs [--execute]
 */

const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')

// Supabase configuration
const SUPABASE_URL = 'https://ulglnabjwwdqnoutnvsl.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsZ2xuYWJqd3dkcW5vdXRudnNsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODU4NjMzNCwiZXhwIjoyMDk0MTYyMzM0fQ.6HkiAHCNWwb-K_wP6LDDaJlO5hFBuNMWNQfYdc9B3ow'

// Production API
const API_BASE = 'https://portal.motions.co.zw'

// Create Supabase client with service role key
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false
  }
})

async function regenerateAllDocuments(dryRun = true) {
  console.log(`\n${dryRun ? 'DRY RUN' : 'EXECUTING'}: Regenerating all policy documents via production API...\n`)

  const payload = {
    dryRun,
    // No filters - regenerate all policies
  }

  try {
    const response = await fetch(`${API_BASE}/api/regenerate-policy-documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify(payload),
    })

    const text = await response.text()
    console.log('API Response:', text.substring(0, 500))

    let result
    try {
      result = JSON.parse(text)
    } catch (e) {
      console.error('Failed to parse JSON response')
      console.error('Response text:', text)
      process.exit(1)
    }

    if (!response.ok) {
      console.error('ERROR:', result.error)
      if (result.details) console.error('Details:', result.details)
      process.exit(1)
    }

    console.log('✓ Success!')
    console.log('Message:', result.message)
    console.log('\nResults:')
    console.log(`  Total policies: ${result.results.total}`)
    console.log(`  Success: ${result.results.success}`)
    console.log(`  Failed: ${result.results.failed}`)

    if (result.results.errors.length > 0) {
      console.log('\nErrors:')
      result.results.errors.forEach(err => {
        console.log(`  - ${err.policyNumber}: ${err.error}`)
      })
    }

    console.log(`\n${dryRun ? 'Dry run complete. Run with --execute to actually regenerate.' : 'Regeneration complete.'}`)

  } catch (error) {
    console.error('ERROR:', error.message)
    console.error('\nMake sure the production API is accessible at https://portal.motions.co.zw')
    console.error('The API endpoint may need to be deployed first.')
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
