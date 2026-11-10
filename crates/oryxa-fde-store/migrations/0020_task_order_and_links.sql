-- The board (#110): a task's place in its project's order, and the success criterion it works towards.

-- Gapped positions: a task goes 65536 after the project's last, or halfway between the two tasks it
-- is moved between; only when those two have no gap left are the project's tasks renumbered (work.rs).
-- Existing tasks keep their creation order. FORCE row-level security applies to the owner too, and no
-- policy names the migrator: lift it for the backfill only, inside this migration's transaction.
alter table tasks add column position bigint;
-- A renumbering changes no field a save replaces, so it leaves the tasks' versions (0019) alone.
create or replace trigger tasks_version before update on tasks for each row
    when (current_setting('fde.renumbering', true) is distinct from 'on')
    execute function fde_bump_version();
alter table tasks no force row level security;
select set_config('fde.renumbering', 'on', true);
update tasks t set position = o.n * 65536
from (select tenant_id, task_id,
             row_number() over (partition by tenant_id, company_id, project_id order by created_at, task_id) as n
      from tasks) o
where t.tenant_id = o.tenant_id and t.task_id = o.task_id;
select set_config('fde.renumbering', '', true);
alter table tasks force row level security;
alter table tasks alter column position set not null;
-- Checked at commit, so a renumbering can pass through duplicates; moves are serialised per project.
alter table tasks add constraint tasks_position_unique unique (tenant_id, company_id, project_id, position)
    deferrable initially deferred;

-- One criterion of the task's own project. Removing the criterion unlinks its tasks.
alter table tasks add column criterion text,
    add foreign key (tenant_id, company_id, project_id, criterion)
        references criteria (tenant_id, company_id, project_id, criterion_id)
        on delete set null (criterion);
