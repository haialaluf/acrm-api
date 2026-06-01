-- Notify the invitee by email once a pending invitation has been created.
-- This trigger existed in the schema (supabase/schemas/03_models/03-04_agents.sql)
-- but was never generated into a migration, so it was missing in the database and
-- the first invitation email was never sent (only the manual "Resend" path worked).
-- Reuses the generic pg_net/vault edge function caller; the payload is the
-- standard webhook shape ({ record, old_record, type, table, schema }).
drop trigger if exists "send_invitation_email" on "public"."agents";

create trigger send_invitation_email
after insert
on public.agents
for each row
when (
  new.ai = false
  and new.extra->'invitation'->>'status' = 'pending'
  and new.extra->'invitation'->>'email' is not null
)
execute function public.edge_function('/send-invitation-email', 'post');
