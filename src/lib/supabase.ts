import { createClient } from '@supabase/supabase-js'

// Support both Vite (import.meta.env) and Node.js (process.env)
const url = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) 
  ? import.meta.env.VITE_SUPABASE_URL as string
  : process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''

const key = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY)
  ? import.meta.env.VITE_SUPABASE_ANON_KEY as string
  : process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''

export const supabase = createClient(url, key)
