-- Issues noted when a timed run is finished (Run Order → Mark done).
-- ===========================================================================================
-- When the operator finishes a job that was started with the timer, a prompt asks what went wrong
-- during the run, each with a count (a run can have 3 thread breaks):
--   thread break · bobbin ran out · bird's nest · needle break · needle replaced · other (+ a note)
-- issuesJson = {"threadBreak":3,"bobbinOut":1,…} — only the kinds that happened, counts >= 1;
--              '{}' = none noted (every run before this migration, and a clean run).
-- issueNote  = the free-text detail for "other".
-- The Run Times report totals these per design and per machine and lists the notes.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.
-- ===========================================================================================
ALTER TABLE production_runs ADD COLUMN issuesJson TEXT NOT NULL DEFAULT '{}';
ALTER TABLE production_runs ADD COLUMN issueNote TEXT NOT NULL DEFAULT '';
