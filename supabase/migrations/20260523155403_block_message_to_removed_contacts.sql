-- Block sending to contacts that opted out (contacts_addresses.status =
-- 'removed'). RESTRICTIVE, so it is AND-ed with the permissive insert policy:
-- the insert is rejected (no row created) when it is an outgoing message whose
-- contact address is marked removed in the same organization. Only affects
-- authenticated/anon roles; the service role (webhook opt-out confirmation,
-- agent-client) bypasses RLS.
create policy "cannot message removed contacts"
on "public"."messages"
as restrictive
for insert
to authenticated, anon
with check (
  (direction <> 'outgoing'::public.direction)
  or (contact_address is null)
  or (not (exists (
    select 1
    from public.contacts_addresses ca
    where ca.organization_id = messages.organization_id
      and ca.address = messages.contact_address
      and ca.status = 'removed'::text
  )))
);
