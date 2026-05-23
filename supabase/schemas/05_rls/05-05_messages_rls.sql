alter table public.messages enable row level security;

-- Note: messages cannot be edited or deleted by the user.

create policy "members can read their orgs messages"
on public.messages
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "members can create their orgs messages"
on public.messages
for insert
to authenticated, anon
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Block sending to contacts that opted out (contacts_addresses.status =
-- 'removed'). RESTRICTIVE so it is AND-ed with the permissive policy above:
-- the insert is rejected (no row created) when it is an outgoing message whose
-- contact address is marked removed in the same organization. Only affects
-- authenticated/anon roles; the service role (webhook opt-out confirmation,
-- agent-client) bypasses RLS.
create policy "cannot message removed contacts"
on public.messages
as restrictive
for insert
to authenticated, anon
with check (
  messages.direction <> 'outgoing'::public.direction
  or messages.contact_address is null
  or not exists (
    select 1
    from public.contacts_addresses ca
    where ca.organization_id = messages.organization_id
      and ca.address = messages.contact_address
      and ca.status = 'removed'
  )
);
