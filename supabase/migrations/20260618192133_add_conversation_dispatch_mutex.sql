-- Per-conversation dispatch mutex to guarantee ordered outgoing delivery.
--
-- A multi-message turn (e.g. a `respond` tool call) inserts several outgoing
-- messages in one batch, and each row independently fires the dispatcher via
-- pg_net. Those invocations run concurrently, so sending each its own message
-- gives no guarantee that WhatsApp receives them in order.
--
-- This mutex lets a single invocation "own" a conversation and drain its
-- pending outgoing messages in timestamp order while the others no-op. Unlike
-- claim_conversation (newest-message-wins takeover), this is a plain TTL mutex:
-- a worker holds it until it releases, or until the TTL lets a later invocation
-- take over after a crash. The lock lives in conversations.extra->'dispatch'
-- (separate from the agent lock at ->'lock') and is mutated under FOR UPDATE so
-- concurrent claims on the same conversation are serialized.
create or replace function public.claim_conversation_dispatch(
  _conversation_id uuid,
  _worker_id uuid,
  _ttl_seconds integer default 30
)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $$
declare
  _lock jsonb;
  _locked_at timestamptz;
  _locked_worker uuid;
begin
  -- Serialize concurrent claims on the same conversation.
  select extra->'dispatch' into _lock
  from public.conversations
  where id = _conversation_id
  for update;

  _locked_at := (_lock->>'at')::timestamptz;
  _locked_worker := (_lock->>'worker')::uuid;

  if _locked_at is null                                            -- free
     or _locked_at < now() - make_interval(secs => _ttl_seconds)  -- stale
     or _worker_id = _locked_worker                               -- heartbeat
  then
    update public.conversations
    set extra = jsonb_set(
      coalesce(extra, '{}'::jsonb),
      '{dispatch}',
      jsonb_build_object('at', now(), 'worker', _worker_id)
    )
    where id = _conversation_id;

    return true;
  end if;

  return false;
end;
$$;

-- Release the dispatch mutex, but only if this worker still owns it (a stale
-- takeover may have reassigned it). Idempotent; safe to call in a finally block.
create or replace function public.release_conversation_dispatch(
  _conversation_id uuid,
  _worker_id uuid
)
returns void
language plpgsql
security invoker
set search_path to ''
as $$
begin
  update public.conversations
  set extra = extra - 'dispatch'
  where id = _conversation_id
    and (extra->'dispatch'->>'worker')::uuid = _worker_id;
end;
$$;
