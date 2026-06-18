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
