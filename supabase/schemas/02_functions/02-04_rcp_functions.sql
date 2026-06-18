create or replace function public.change_contact_address(
  p_organization_id uuid,
  old_address text,
  new_address text
)
returns void
language plpgsql
security invoker
set search_path to ''
as $$
declare
  _contact_id uuid;
  _service public.service;
begin
  -- 1. Search for old contact address and get service & contact_id
  select service, contact_id into _service, _contact_id
  from public.contacts_addresses
  where organization_id = p_organization_id
    and address = old_address;

  if _service is null then
    return; -- Exit if not found
  end if;

  -- 2. Create new contact address (linked to same contact if it exists)
  -- Add extra.replaces_address
  insert into public.contacts_addresses (
    organization_id, service, address, contact_id, status, extra
  )
  values (
    p_organization_id, 
    _service, 
    new_address, 
    _contact_id, 
    'active',
    jsonb_build_object('replaces_address', old_address)
  )
  on conflict (organization_id, address) do update set
    contact_id = EXCLUDED.contact_id,
    status = 'active',
    extra = jsonb_set(
      coalesce(public.contacts_addresses.extra, '{}'::jsonb),
      '{replaces_address}',
      to_jsonb(old_address)
    );

  -- 3. Update old contact address status and add reference to new address
  update public.contacts_addresses set 
    status = 'inactive',
    extra = jsonb_set(
      coalesce(extra, '{}'::jsonb),
      '{replaced_by_address}',
      to_jsonb(new_address)
    )
  where organization_id = p_organization_id
    and address = old_address;
end;
$$;

-- Per-conversation processing lock with "newest message wins" takeover.
--
-- The agent-client Edge Function is triggered once per incoming message and the
-- triggers dispatch asynchronously (pg_net), so several invocations for the same
-- conversation can run concurrently. Without coordination two invocations can
-- both decide they are the newest and each send a reply.
--
-- This function provides an atomic claim. It is called twice per invocation:
--   1. As a gate before processing starts.
--   2. As a guard (and heartbeat) right before persisting the response.
--
-- The lock lives in conversations.extra->'lock' and is mutated under a row-level
-- FOR UPDATE, so concurrent claims on the same conversation are serialized. A
-- claim succeeds when the lock is free, stale (a crashed invocation), held by
-- this same message (heartbeat), or held by an older message (takeover). The
-- ordering mirrors getNewestIncomingMessage: by created_at, then id as a
-- tie-breaker. No explicit release is needed: created_at is monotonic, so any
-- future message can always take over a left-behind lock.
create or replace function public.claim_conversation(
  _conversation_id uuid,
  _message_id uuid,
  _message_at timestamptz,
  _ttl_seconds integer default 120
)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $$
declare
  _lock jsonb;
  _locked_at timestamptz;
  _locked_message_at timestamptz;
  _locked_message_id uuid;
begin
  -- Serialize concurrent claims on the same conversation.
  select extra->'lock' into _lock
  from public.conversations
  where id = _conversation_id
  for update;

  _locked_at := (_lock->>'at')::timestamptz;
  _locked_message_at := (_lock->>'message_at')::timestamptz;
  _locked_message_id := (_lock->>'message_id')::uuid;

  if _locked_at is null                                              -- free
     or _locked_at < now() - make_interval(secs => _ttl_seconds)    -- stale
     or _message_id = _locked_message_id                            -- heartbeat
     or _message_at > _locked_message_at                            -- newer message
     or (_message_at = _locked_message_at
         and _message_id > _locked_message_id)                      -- tie-break by id
  then
    update public.conversations
    set extra = jsonb_set(
      coalesce(extra, '{}'::jsonb),
      '{lock}',
      jsonb_build_object(
        'at', now(),
        'message_at', _message_at,
        'message_id', _message_id
      )
    )
    where id = _conversation_id;

    return true;
  end if;

  return false;
end;
$$;

create function public.init_data(
  p_organization_id uuid,
  p_limit integer default 200,
  p_per_conversation integer default 10,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns json
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  _messages json;
  _conversations json;
  _conversation_ids uuid[];
begin
  -- Windowed messages: up to p_per_conversation per conversation, total p_limit
  with windowed as (
    select m.*,
      row_number() over (
        partition by m.conversation_id
        order by m.timestamp desc
      ) as rn
    from public.messages m
    where m.organization_id = p_organization_id
      and (p_since is null or m.timestamp > p_since)
      and (p_until is null or m.timestamp < p_until)
  ),
  limited as (
    select * from windowed
    where rn <= p_per_conversation
    order by timestamp desc
    limit p_limit
  )
  select
    coalesce(json_agg(row_to_json(l.*)), '[]'::json),
    array_agg(distinct l.conversation_id)
  into _messages, _conversation_ids
  from limited l;

  -- Fetch conversations for the messages returned
  select coalesce(json_agg(row_to_json(c.*)), '[]'::json)
  into _conversations
  from public.conversations c
  where c.id = any(_conversation_ids);

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$$;
