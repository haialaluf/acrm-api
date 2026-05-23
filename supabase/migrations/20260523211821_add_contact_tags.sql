alter table "public"."contacts" add column "tags" text[] not null default '{}'::text[];
