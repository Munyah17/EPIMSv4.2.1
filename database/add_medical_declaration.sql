-- Medical-aid underwriting: every health product policy must record
-- whether the policyholder has a chronic illness. Two plain columns on
-- policies; a dependant's answer rides inside the dependants JSONB as
-- hasChronicIllness / chronicIllnessDetails, matching how dependant
-- gender/phone already travel there.

ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS has_chronic_illness boolean;
ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS chronic_illness_details text;
