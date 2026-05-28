alter table "public"."contacts" add column "source" text not null default 'manual'::text;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.manage_contact_on_address_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- Case 1: Synced Action = ADD
  if new.extra->'synced'->>'action' = 'add' then
    if old is not null and old.contact_id is not null then
      -- Preserve existing link: the upsert payload doesn't include contact_id,
      -- so new.contact_id would be null and overwrite the existing link.
      new.contact_id := old.contact_id;
    elsif new.contact_id is null then
      -- No contact linked from either side, create one
      insert into public.contacts (
        organization_id,
        name,
        source
      ) values (
        new.organization_id,
        new.extra->'synced'->>'name',
        new.service::text
      ) returning id into new.contact_id;
    end if;
  end if;

  -- Case 1b: First-time INSERT with no synced marker (e.g. inbound message from
  -- a new address). Auto-create a contact so the address is linked from the start.
  if tg_op = 'INSERT'
     and new.contact_id is null
     and new.extra->'synced' is null then
    insert into public.contacts (
      organization_id,
      name,
      source
    ) values (
      new.organization_id,
      new.extra->>'name',
      'incoming_message'
    ) returning id into new.contact_id;
  end if;

  -- Case 2: Synced Action = REMOVE
  -- Unlink. The orphan cleanup happens in the AFTER trigger below to avoid
  -- error 27000 ("tuple to be updated was already modified by an operation
  -- triggered by the current command") caused by the ON DELETE SET NULL
  -- cascade touching the current row.
  -- Note: the address itself might be deleted by cleanup_unlinked_address_if_empty.
  if new.extra->'synced'->>'action' = 'remove' then
    new.contact_id := null;
  end if;

  return new;
end;
$function$
;

drop trigger if exists "manage_contact_on_address_sync" on "public"."contacts_addresses";

CREATE TRIGGER manage_contact_on_address_sync
  BEFORE INSERT OR UPDATE ON public.contacts_addresses
  FOR EACH ROW
  WHEN ((((new.extra -> 'synced'::text) IS NOT NULL) OR (new.contact_id IS NULL)))
  EXECUTE FUNCTION public.manage_contact_on_address_sync();
