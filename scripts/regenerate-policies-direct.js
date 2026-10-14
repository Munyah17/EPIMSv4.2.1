/**
 * Direct policy document regeneration using service role key.
 * This script bypasses the API and generates PDFs directly.
 */

const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')

// Configuration
const SUPABASE_URL = 'https://ulglnabjwwdqnoutnvsl.supabase.co'
const SERVICE_ROLE_KEY = 'sbp_fc5363faf4d4358419358b1bf81ced64ddab8707'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// We need to dynamically import the export functions since they use ES modules
async function getExportUtils() {
  // Create a temporary script to import the ES modules
  const tempScript = `
    const { getPolicyReportPdfBase64 } = require('../src/lib/exportUtils.ts');
    const { uploadDocument } = require('../src/lib/storage.ts');
    module.exports = { getPolicyReportPdfBase64, uploadDocument };
  `
  // Since we can't directly import TS files in Node, we'll need to use the compiled JS
  // For now, let's try a different approach - use the API endpoint
  return null
}

async function regenerateDocuments() {
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
  console.log('This will regenerate ALL policy documents with the updated terms and conditions.')
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

      // Call the API endpoint directly using service role auth
      const category = policy.category || 'general'

      // We'll need to call the API with service role key
      const response = await fetch('https://portal.motions.co.zw/api/regenerate-policy-documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          category,
          dryRun: false,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        failed++
        errors.push({ policyNumber: policy.policy_number, error: error.error || 'API error' })
        console.log(`❌ ${policy.policy_number}: ${error.error || 'API error'}`)
        continue
      }

      success++
      console.log(`✓ ${policy.policy_number}: Queued for regeneration`)

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

regenerateDocuments()
