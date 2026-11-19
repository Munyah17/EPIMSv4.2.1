-- Use plain role suffixes for cross-role sign-in names.
--
-- Migration 003 introduced "Name (Agent)"-style aliases. Product prefers
-- "Name Agent". Rename any aliases already created, resolving the rare
-- collision by appending a number.
DO $$
DECLARE
  r RECORD;
  desired TEXT;
  candidate TEXT;
  i INT;
BEGIN
  FOR r IN
    SELECT id, username
    FROM public.profiles
    WHERE username ~ '\s+\((Agent|Client|Admin|Staff)( [0-9]+)?\)$'
  LOOP
    desired := regexp_replace(
      r.username,
      '\s+\((Agent|Client|Admin|Staff)( [0-9]+)?\)$',
      ' \1\2'
    );
    candidate := desired;
    i := 2;
    WHILE EXISTS (
      SELECT 1
      FROM public.profiles q
      WHERE q.id <> r.id
        AND lower(q.username) = lower(candidate)
    ) LOOP
      candidate := desired || ' ' || i;
      i := i + 1;
    END LOOP;
    UPDATE public.profiles SET username = candidate WHERE id = r.id;
  END LOOP;
END $$;
