import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "./logger.ts";
import type { Database } from "./types/database_types.ts";

type UpsertedAddress = {
  organization_id: string;
  address: string;
  service: Database["public"]["Enums"]["service"];
  contact_id: string | null;
  extra: Record<string, unknown> | null;
};

/**
 * For each upserted contacts_addresses row without a contact_id, create a
 * contact and link it. Used by inbound-message webhooks to materialize a
 * contact on first sight of an address. Replaces the previous BEFORE INSERT
 * trigger, which fired on every upsert (including no-op conflicts) and
 * produced orphaned contacts.
 */
export async function linkMissingContacts(
  client: SupabaseClient<Database>,
  upserted: UpsertedAddress[],
): Promise<void> {
  const orphans = upserted.filter((a) => !a.contact_id);
  if (orphans.length === 0) return;

  const { data: newContacts, error: insertError } = await client
    .from("contacts")
    .insert(
      orphans.map((a) => ({
        organization_id: a.organization_id,
        name: (a.extra?.name as string | undefined) ?? null,
        source: "incoming_message",
      })),
    )
    .select("id");

  if (insertError) {
    log.error("Failed to insert contacts for new addresses", {
      error: insertError,
      orphans,
    });
    throw insertError;
  }

  await Promise.all(
    newContacts.map((c, i) => {
      const a = orphans[i];
      return client
        .from("contacts_addresses")
        .update({ contact_id: c.id })
        .eq("organization_id", a.organization_id)
        .eq("address", a.address)
        .eq("service", a.service)
        .throwOnError();
    }),
  );
}
