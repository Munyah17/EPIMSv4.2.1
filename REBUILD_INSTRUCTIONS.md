# Tariqify IMS — Database Rebuild Instructions

## What happened?
The Supabase database was corrupted during user account changes. This rebuild restores everything with **improved security**.

## What's new in this rebuild?
- **Complete reset** — drops all tables, policies, functions, and triggers cleanly
- **Fixed RLS policies** — previous `policies_select_own` had a self-referencing bug that could block reads
- **Robust auth helpers** — `is_staff()` and `current_user_role()` now return safe defaults (`FALSE` / `''`) instead of `NULL`
- **Delete policies** — every table now has explicit DELETE rules (admin-only for sensitive tables, staff for operational tables)
- **Auto `updated_at`** — clients, policies, and tickets automatically update their `updated_at` timestamp
- **Forced RLS** — RLS is enforced even for table owners, preventing accidental bypass
- **Better indexes** — added `idx_policies_agent`, `idx_claims_assigned`, `idx_leads_assigned`, `idx_tickets_client`, `idx_profiles_role`, `idx_profiles_active`
- **Owns-policy helper** — new `owns_policy(UUID)` function for policyholder portal queries

## Step-by-Step Rebuild

### 1. Open Supabase SQL Editor
1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Go to **SQL Editor** → **New Query**

### 2. Run the rebuild script
1. Open `my-app/rebuild_database.sql` in your code editor
2. Copy the **entire** file contents
3. Paste into the Supabase SQL Editor
4. Click **Run**

> The script is idempotent. If you need to re-run it, it will clean everything first and rebuild from scratch.

### 3. Verify the rebuild
Uncomment the verification queries at the bottom of `rebuild_database.sql` (lines starting with `-- SELECT`) and run them:

```sql
SELECT 'Tables' as check_type, COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public';
SELECT 'Profiles' as check_type, COUNT(*) as count FROM public.profiles;
SELECT 'Auth Users' as check_type, COUNT(*) as count FROM auth.users WHERE email LIKE '%@tariqify.com' OR email = 'client@example.com';
```

Expected:
- **Tables**: 11
- **Profiles**: 7
- **Auth Users**: 7

### 4. Test login credentials

| Email | Password | Role |
|---|---|---|
| `admin@tariqify.com` | `admin1234` | super_admin |
| `claims@tariqify.com` | `staff1234` | claims_officer |
| `policy@tariqify.com` | `staff1234` | policy_admin |
| `finance@tariqify.com` | `staff1234` | finance |
| `crm@tariqify.com` | `staff1234` | client_relations |
| `client@example.com` | `client1234` | policyholder |
| `admin2@tariqify.com` | `staff1234` | admin |

### 5. Test the app locally
```bash
cd my-app
npm run dev
```

## Troubleshooting

### "permission denied for schema public"
- This is a Supabase new-project issue. Run this first:
```sql
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
```

### Auth users don't appear in profiles
- The `handle_new_user()` trigger auto-creates profiles when auth.users rows are inserted.
- If profiles are missing, the trigger may not be attached. Re-run just the trigger section from `rebuild_database.sql`.

### RLS blocking everything
- The app uses the **anon key** which respects RLS.
- Ensure your `.env` has the correct `VITE_SUPABASE_ANON_KEY`.
- The seed users use `crypt('password', gen_salt('bf'))` — you must log in via Supabase Auth (not SQL) for the session to work.

### Need to add a new user manually
```sql
-- 1. Create auth user
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token)
VALUES ('your-uuid-here', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'newuser@tariqify.com', crypt('password123', gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}', '{"name":"New User","role":"policy_admin","department":"Administration"}', false, '');

-- 2. Profile is auto-created by trigger, or update it:
UPDATE public.profiles SET role='admin', department='Operations', active=true WHERE id='your-uuid-here';
```

## Files changed
- `my-app/rebuild_database.sql` — new complete rebuild script
- `my-app/supabase_schema.sql` — updated to match rebuild
- `my-app/reset_database.sql` — updated reset script
- `my-app/create_profiles_first.sql` — updated profile trigger

## Important: Do NOT run old scripts separately
The old `reset_database.sql` + `create_profiles_first.sql` + `supabase_schema.sql` combination is **deprecated**. Always use `rebuild_database.sql` for a clean rebuild.
