/**
 * Local script to regenerate policy documents directly via Supabase
 * Run with: npx tsx regenerate-documents-local.ts
 */

import * as dotenv from 'dotenv'

// Load .env file first
dotenv.config()

// Set Vite environment variables for the imported modules
process.env.VITE_SUPABASE_URL = process.env.SUPABASE_URL || ''
process.env.VITE_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

import { createClient } from '@supabase/supabase-js'

// Import after setting environment variables
import { getPolicyReportPdfBase64 } from './src/lib/exportUtils.ts'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
})

async function regenerateAllDocuments() {
  console.log('Fetching all policies...')
  
  const { data: policies, error: fetchError } = await supabase
    .from('policies')
    .select('*, clients(*)')
  
  if (fetchError) {
    console.error('Failed to fetch policies:', fetchError.message)
    process.exit(1)
  }
  
  if (!policies || policies.length === 0) {
    console.log('No policies found')
    return
  }
  
  console.log(`Found ${policies.length} policies. Starting regeneration...`)
  
  let success = 0
  let failed = 0
  const errors: string[] = []
  
  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i]
    console.log(`[${i + 1}/${policies.length}] Processing ${policy.policy_number}...`)
    
    try {
      const client = policy.clients
      if (!client) {
        failed++
        errors.push(`${policy.policy_number}: Client not found`)
        continue
      }
      
      const category = policy.category || 'general'
      
      // Generate new PDF
      const pdfBase64 = await getPolicyReportPdfBase64(policy, client, category)
      
      // Upload to storage
      const pdfBuffer = Buffer.from(pdfBase64, 'base64')
      const filename = `${policy.policy_number}-Policy-Report.pdf`
      const storagePath = `${policy.id}/${filename}`
      
      const { error: uploadError } = await supabase.storage
        .from('policies')
        .upload(storagePath, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true
        })
      
      if (uploadError) {
        failed++
        errors.push(`${policy.policy_number}: ${uploadError.message}`)
        continue
      }
      
      // Update policy documents array
      const currentDocs = policy.documents || []
      const updatedDocs = [...currentDocs, `policies/${storagePath}`]
      
      const { error: updateError } = await supabase
        .from('policies')
        .update({ documents: updatedDocs })
        .eq('id', policy.id)
      
      if (updateError) {
        failed++
        errors.push(`${policy.policy_number}: ${updateError.message}`)
        continue
      }
      
      success++
      console.log(`  ✓ Success`)
    } catch (err) {
      failed++
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      errors.push(`${policy.policy_number}: ${errorMsg}`)
      console.log(`  ✗ Failed: ${errorMsg}`)
    }
  }
  
  console.log('\n=== Summary ===')
  console.log(`Total: ${policies.length}`)
  console.log(`Success: ${success}`)
  console.log(`Failed: ${failed}`)
  
  if (errors.length > 0) {
    console.log('\nErrors:')
    errors.forEach(err => console.log(`  - ${err}`))
  }
}

regenerateAllDocuments().catch(console.error)
