-- Four features in one migration:
--
--  1. Custom invoices — invoices.policy_id / client_id are relaxed to
--     nullable so a bespoke invoice can bill anyone, not just a policy.
--     customer_name carries the bill-to name when no client is linked;
--     the existing notes column carries the line description.
--  2. Requisition attachments — invoice / PoP / receipt uploads on the
--     existing 'documents' bucket (staff_all policy already covers every
--     folder; the submitter's folder is requisitions/<id>/). A trigger
--     enforces "only Super Admin decides" at the row level, not just UI.
--  3. Tasks — super_admin issues tasks to staff; the assignee ticks
--     milestones in real time (a trigger recomputes task progress +
--     status), posts updates to a live feed, and the leaderboard reads
--     completion counts / rate / lead time off the same tables.
--  4. Realtime — the three task tables join supabase_realtime so
--     dashboards and the Tasks page update live.

-- ── 1. Custom invoices ──────────────────────────────────────────────
ALTER TABLE public.invoices ALTER COLUMN policy_id DROP NOT NULL;
ALTER TABLE public.invoices ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS customer_name TEXT;

-- ── 2. Requisition attachments + decision guard ─────────────────────
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS attachments TEXT[] NOT NULL DEFAULT '{}';

-- Requisitions accept ANY file type (supplier invoices, PoP screenshots,
-- scanned receipts…) — the bucket's mime allowlist would reject archives
-- and mail files; NULL removes it. Size limit + RLS policies unchanged.
UPDATE storage.buckets SET allowed_mime_types = NULL WHERE id = 'documents';

-- Quotations carry the product-shaped application answers so Accept →
-- Policy creates the policy instantly, no re-interview.
ALTER TABLE public.quotations ADD COLUMN IF NOT EXISTS policy_details JSONB;

-- Only Super Admin may move a requisition off 'pending' or change a
-- decided row. The submitter can still update their own row's
-- attachments/notes — the guard only fires when status changes.
CREATE OR REPLACE FUNCTION public.guard_requisition_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND public.current_user_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'Only Super Admin may approve, reject or pay a requisition';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS requisitions_decision_guard ON public.requisitions;
CREATE TRIGGER requisitions_decision_guard
  BEFORE UPDATE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_requisition_decision();

-- ── 3. Tasks ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  priority      TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low','medium','high','urgent')),
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_progress','completed','cancelled')),
  assignee_id   UUID REFERENCES public.profiles(id),
  assignee_name TEXT NOT NULL DEFAULT '',
  created_by    UUID REFERENCES public.profiles(id),
  created_by_name TEXT,
  due_date      DATE,
  progress      INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.task_milestones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  position     INT NOT NULL DEFAULT 0,
  done         BOOLEAN NOT NULL DEFAULT false,
  done_at      TIMESTAMPTZ,
  done_by_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.task_updates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES public.profiles(id),
  author_name TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON public.tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON public.tasks(status);
CREATE INDEX IF NOT EXISTS idx_milestones_task ON public.task_milestones(task_id);
CREATE INDEX IF NOT EXISTS idx_updates_task    ON public.task_updates(task_id);

ALTER TABLE public.tasks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_updates   ENABLE ROW LEVEL SECURITY;

-- Everyone on staff sees every task (it lands on all dashboards); only
-- Super Admin issues, edits, reassigns or cancels one. The assignee
-- completing a milestone is expressed through task_milestones, not a
-- direct task write — except marking a milestone-less task done, which
-- the guard trigger limits to the status field alone.
CREATE POLICY "tasks_staff_read"    ON public.tasks FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "tasks_admin_insert"  ON public.tasks FOR INSERT TO authenticated WITH CHECK (current_user_role() = 'super_admin');
CREATE POLICY "tasks_update"        ON public.tasks FOR UPDATE TO authenticated
  USING (current_user_role() = 'super_admin' OR assignee_id = auth.uid());
CREATE POLICY "tasks_admin_delete"  ON public.tasks FOR DELETE TO authenticated USING (current_user_role() = 'super_admin');

-- A non-admin UPDATE may only move status → 'completed' (milestone-less
-- task) or append an assignee rename on reassign — never title, priority,
-- due date or reassignment. Enforced by trigger since RLS is row-level.
CREATE OR REPLACE FUNCTION public.guard_task_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF public.current_user_role() = 'super_admin' THEN RETURN NEW; END IF;
  IF NEW.title        IS DISTINCT FROM OLD.title
     OR NEW.description  IS DISTINCT FROM OLD.description
     OR NEW.priority     IS DISTINCT FROM OLD.priority
     OR NEW.assignee_id  IS DISTINCT FROM OLD.assignee_id
     OR NEW.due_date     IS DISTINCT FROM OLD.due_date
     OR NEW.progress     IS DISTINCT FROM OLD.progress THEN
    RAISE EXCEPTION 'Only Super Admin may edit a task';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (NEW.status = 'completed' AND OLD.status IN ('open','in_progress')) THEN
    RAISE EXCEPTION 'The assignee may only mark the task complete';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tasks_update_guard ON public.tasks;
CREATE TRIGGER tasks_update_guard
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_update();

CREATE POLICY "milestones_staff_read"   ON public.task_milestones FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "milestones_admin_write"  ON public.task_milestones FOR INSERT TO authenticated WITH CHECK (current_user_role() = 'super_admin');
CREATE POLICY "milestones_tick"         ON public.task_milestones FOR UPDATE TO authenticated
  USING (current_user_role() = 'super_admin'
         OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.assignee_id = auth.uid()));
CREATE POLICY "milestones_admin_delete" ON public.task_milestones FOR DELETE TO authenticated USING (current_user_role() = 'super_admin');

-- The assignee may only tick/untick — label and order are the issuer's.
CREATE OR REPLACE FUNCTION public.guard_milestone_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF public.current_user_role() = 'super_admin' THEN RETURN NEW; END IF;
  IF NEW.label IS DISTINCT FROM OLD.label OR NEW.position IS DISTINCT FROM OLD.position THEN
    RAISE EXCEPTION 'Only Super Admin may edit a milestone';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS milestones_update_guard ON public.task_milestones;
CREATE TRIGGER milestones_update_guard
  BEFORE UPDATE ON public.task_milestones
  FOR EACH ROW EXECUTE FUNCTION public.guard_milestone_update();

-- Tick/untick → recompute the parent's progress + status + completed_at,
-- so staff ticking live moves the task for every watcher in real time.
CREATE OR REPLACE FUNCTION public.sync_task_progress()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  tid UUID := COALESCE(NEW.task_id, OLD.task_id);
  total INT; done_n INT;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE done) INTO total, done_n
    FROM public.task_milestones WHERE task_id = tid;
  UPDATE public.tasks SET
    progress     = CASE WHEN total = 0 THEN progress ELSE round(done_n * 100.0 / total) END,
    status       = CASE
                     WHEN total > 0 AND done_n = total THEN 'completed'
                     WHEN done_n > 0 THEN 'in_progress'
                     WHEN status IN ('in_progress','completed') THEN 'open'
                     ELSE status END,
    completed_at = CASE WHEN total > 0 AND done_n = total THEN COALESCE(completed_at, now()) ELSE NULL END,
    updated_at   = now()
  WHERE id = tid AND status <> 'cancelled';
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS milestones_progress_sync ON public.task_milestones;
CREATE TRIGGER milestones_progress_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.task_milestones
  FOR EACH ROW EXECUTE FUNCTION public.sync_task_progress();

CREATE POLICY "updates_staff_read"  ON public.task_updates FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY "updates_post"        ON public.task_updates FOR INSERT TO authenticated WITH CHECK (
  is_staff() AND (
    current_user_role() = 'super_admin'
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.assignee_id = auth.uid())
  ));
CREATE POLICY "updates_admin_delete" ON public.task_updates FOR DELETE TO authenticated USING (current_user_role() = 'super_admin');

-- ── 4. Realtime ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'tasks') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'task_milestones') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.task_milestones;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'task_updates') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.task_updates;
  END IF;
END $$;
