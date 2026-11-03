-- Fix for databases that already ran extend_accounting_docs_tasks.sql.
--
-- Bug: every staff milestone tick rolled back with
--   "Only Super Admin may edit a task"
-- The tick writes task_milestones fine, but milestones_progress_sync then
-- UPDATEs the parent task (progress/status/completed_at) — and
-- guard_task_update rejected it because current_user_role() still reads
-- the staff member's role inside the SECURITY DEFINER function.
--
-- Fix: trigger-initiated writes run at pg_trigger_depth() > 1; a client
-- UPDATE always fires the guard at depth 1, so >1 means "system write".
-- The trigger itself already calls this function by name — replacing the
-- function body is all that's needed, no DROP TRIGGER.

CREATE OR REPLACE FUNCTION public.guard_task_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
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
