/**
 * Test script for regenerating policy documents.
 * Run this from the imsv3 directory: node scripts/regenerate-documents.js
 *
 * This script allows you to test the regenerate-policy-documents endpoint
 * with various filters before running it on all policies.
 */

const API_BASE = 'https://portal.motions.co.zw' // Production API

async function regenerateDocuments(options = {}) {
  const {
    category = null,      // 'funeral', 'agriculture', 'medical', etc.
    status = null,        // 'active', 'lapsed', etc.
    startDate = null,     // ISO date string
    endDate = null,       // ISO date string
    dryRun = false,       // Set to false to actually regenerate
    token = null,         // Auth token from localStorage OR service role key
  } = options

  if (!token) {
    console.error('ERROR: Auth token required. Get it from browser localStorage (tqfy_sb_token) or use service role key')
    process.exit(1)
  }

  const payload = {
    category,
    status,
    startDate,
    endDate,
    dryRun,
  }

  console.log('Regenerating policy documents with options:', JSON.stringify(payload, null, 2))

  try {
    const response = await fetch(`${API_BASE}/api/regenerate-policy-documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })

    const result = await response.json()

    if (!response.ok) {
      console.error('ERROR:', result.error)
      if (result.details) console.error('Details:', result.details)
      process.exit(1)
    }

    console.log('\n✓ Success!')
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

  } catch (error) {
    console.error('ERROR:', error.message)
    process.exit(1)
  }
}

// Example usage - modify as needed
const args = process.argv.slice(2)
const options = {
  dryRun: true, // Always start with dryRun=true
}

// Parse command line arguments
args.forEach(arg => {
  if (arg.startsWith('--category=')) options.category = arg.split('=')[1]
  if (arg.startsWith('--status=')) options.status = arg.split('=')[1]
  if (arg.startsWith('--startDate=')) options.startDate = arg.split('=')[1]
  if (arg.startsWith('--endDate=')) options.endDate = arg.split('=')[1]
  if (arg === '--execute') options.dryRun = false
  if (arg.startsWith('--token=')) options.token = arg.split('=')[1]
})

if (!options.token) {
  console.log('Usage: node scripts/regenerate-documents.js --token=<your-auth-token> [options]')
  console.log('')
  console.log('Options:')
  console.log('  --category=<category>    Filter by policy category (funeral, agriculture, etc.)')
  console.log('  --status=<status>        Filter by policy status (active, lapsed, etc.)')
  console.log('  --startDate=<date>      Filter by creation date (ISO format)')
  console.log('  --endDate=<date>        Filter by creation date (ISO format)')
  console.log('  --execute               Actually regenerate (default is dry-run)')
  console.log('')
  console.log('Example:')
  console.log('  node scripts/regenerate-documents.js --token=xxx --category=funeral --dryRun')
  console.log('  node scripts/regenerate-documents.js --token=xxx --execute')
  process.exit(0)
}

regenerateDocuments(options)
