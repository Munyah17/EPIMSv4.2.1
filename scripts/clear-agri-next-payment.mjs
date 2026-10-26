import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://ulglnabjwwdqnoutnvsl.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const { data: products } = await supabase.from('products').select('id, name, category').eq('category', 'agriculture')
const ids = products.map(p => p.id)
console.log('Agriculture products:', products.map(p => p.name).join(', '))

const { data, error, count } = await supabase
  .from('policies')
  .update({ next_payment_date: null })
  .in('product_id', ids)
  .not('next_payment_date', 'is', null)
  .select('id')
if (error) { console.error(error); process.exit(1) }
console.log(`Cleared next_payment_date on ${data.length} agriculture policies`)
