/**
 * Regenerate policy documents using service role key.
 * This script bypasses the session auth and uses the service role key directly.
 */

const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')

// Configuration
const SUPABASE_URL = 'https://ulglnabjwwdqnoutnvsl.supabase.co'
const SERVICE_ROLE_KEY = 'sbp_fc5363faf4d4358419358b1bf81ced64ddab8707'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

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

  console.log(`Found ${policies.length} policies. Starting regeneration...`)

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

      // Import the PDF generation function
      // We need to do this dynamically since it uses ES modules
      const { getPolicyReportPdfBase64 } = await import('../src/lib/exportUtils.ts')
      const { uploadDocument } = await import('../src/lib/storage.ts')

      const category = policy.category || 'general'
      const pdfBase64 = await getPolicyReportPdfBase64(policy, client, category)

      // Convert base64 to buffer
      const pdfBuffer = Buffer.from(pdfBase64, 'base64')
      const filename = `${policy.policy_number}-Policy-Report.pdf`

      // Upload to storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('policies')
        .upload(`${policy.id}/${filename}`, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true
        })

      if (uploadError) {
        failed++
        errors.push({ policyNumber: policy.policy_number, error: uploadError.message })
        console.log(`❌ ${policy.policy_number}: Upload failed - ${uploadError.message}`)
        continue
      }

      // Update policy documents array
      const currentDocs = policy.documents || []
      const updatedDocs = [...currentDocs, `policies/${policy.id}/${filename}`]

      const { error: updateError } = await supabase
        .from('policies')
        .update({ documents: updatedDocs })
        .eq('id', policy.id)

      if (updateError) {
        failed++
        errors.push({ policyNumber: policy.policy_number, error: updateError.message })
        console.log(`❌ ${policy.policy_number}: Update failed - ${updateError.message}`)
        continue
      }

      success++
      console.log(`✓ ${policy.policy_number}: Regenerated successfully`)

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
