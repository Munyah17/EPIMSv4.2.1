-- Single-insurer cleanup.
--
-- This system underwrites for Motions Microinsurance only. Earlier seeds
-- filled the insurers table with every registered insurer in the country,
-- which is how competitor names ended up selectable on forms. This script
-- removes them: rows no policy/client references are deleted outright;
-- anything still referenced is deactivated rather than deleted, because
-- policies.insurer holds the name as text, not a foreign key, and deleting
-- it would orphan those records.
--
-- Run once against the live database.

-- Normalize the house insurer's name to the full registered name.
UPDATE public.insurers
   SET name = 'Motions Microinsurance'
 WHERE name = 'Motions';

INSERT INTO public.insurers (name, status) VALUES
  ('Motions Microinsurance', 'active')
ON CONFLICT (name) DO NOTHING;

-- Deactivate every other insurer so nothing else can ever be selected.
UPDATE public.insurers
   SET status = 'inactive'
 WHERE name <> 'Motions Microinsurance';

-- Drop unreferenced rows entirely; referenced ones stay but inactive.
DELETE FROM public.insurers
 WHERE name <> 'Motions Microinsurance'
   AND name NOT IN (SELECT DISTINCT insurer FROM public.policies WHERE insurer IS NOT NULL)
   AND name NOT IN (SELECT DISTINCT insurer FROM public.clients WHERE insurer IS NOT NULL);
