-- ============================================================================
-- 0026_composite_fk_set_null.sql
-- D41 — Three tenant-scoped foreign keys made their parent row undeletable.
--
-- ---------------------------------------------------------------------------
-- WHAT IS WRONG
-- ---------------------------------------------------------------------------
-- This schema scopes child rows to their tenant with a COMPOSITE foreign key:
--
--     foreign key (org_id, buddy_group_id)
--         references buddy_groups (org_id, id) on delete set null
--
-- That is the right shape — it is what stops an entry in org A pointing at a
-- buddy group in org B. But `on delete set null` with no column list means
-- "null every referencing column", and the referencing columns here are
-- (org_id, buddy_group_id). org_id is NOT NULL. So the cascade tries to write
-- a null into a NOT NULL column and the delete fails:
--
--     ERROR:  null value in column "org_id" violates not-null constraint
--     CONTEXT:  UPDATE ONLY "entries" SET "org_id" = NULL, "buddy_group_id" = NULL
--
-- The tables and what it costs each of them:
--
--   * entries → buddy_groups. A buddy group cannot be deleted once anybody has
--     joined it. Secretaries build a group, somebody enters, the group turns
--     out to be wrong, and it can never be removed.
--
--   * welfare_records → animals. An animal with a welfare record on file can
--     never be deleted. A test entry for the wrong horse is permanent.
--
--   * discipline_records → rodeos. A rodeo where anybody was fined cannot be
--     deleted — including a rodeo created by mistake.
--
-- None of this shows up until somebody deletes a parent row, which is why it
-- survived to here: every test in this repository builds rows and asserts on
-- them, and almost none of them delete a parent.
--
-- ---------------------------------------------------------------------------
-- THE FIX
-- ---------------------------------------------------------------------------
-- PostgreSQL 15 added a column list to the referential action:
--
--     on delete set null (buddy_group_id)
--
-- which nulls the pointer and leaves the tenant column alone — exactly the
-- intent. Supabase runs 15 or later, so this is available.
--
-- `career_runs` has the same shape and is deliberately left as it is: both of
-- its referencing columns are nullable, because a career run outlives the
-- organisation that recorded it. Nulling both is correct there.
-- ============================================================================

alter table entries
    drop constraint entries_org_id_buddy_group_id_fkey;
alter table entries
    add constraint entries_org_id_buddy_group_id_fkey
    foreign key (org_id, buddy_group_id) references buddy_groups (org_id, id)
    on delete set null (buddy_group_id);

alter table welfare_records
    drop constraint welfare_records_org_id_animal_id_fkey;
alter table welfare_records
    add constraint welfare_records_org_id_animal_id_fkey
    foreign key (org_id, animal_id) references animals (org_id, id)
    on delete set null (animal_id);

alter table discipline_records
    drop constraint discipline_records_org_id_rodeo_id_fkey;
alter table discipline_records
    add constraint discipline_records_org_id_rodeo_id_fkey
    foreign key (org_id, rodeo_id) references rodeos (org_id, id)
    on delete set null (rodeo_id);
