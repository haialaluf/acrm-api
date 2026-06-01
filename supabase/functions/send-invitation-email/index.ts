import * as log from "../_shared/logger.ts";
import { corsHeaders, errorHandler } from "../_shared/cors.ts";
import { createClient } from "../_shared/supabase_client.ts";
import type {
  AgentRow,
  HumanAgentExtra,
  WebhookPayload,
} from "../_shared/supabase.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
// Verified sender for the system (invitation) emails, e.g. "ACRM <no-reply@tika-ai.com>".
const INVITATION_FROM_EMAIL = Deno.env.get("INVITATION_FROM_EMAIL") || "";
// Base URL of the app the invitee should open to sign in and accept.
const APP_URL = Deno.env.get("APP_URL") || "https://acrm-app.tika-ai.com";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildEmail(organizationName: string, role: string) {
  const org = escapeHtml(organizationName);
  const safeRole = escapeHtml(role);
  const subject = `You have been invited to join ${organizationName}`;

  const text =
    `You've been invited to join ${organizationName} as ${role}.\n\n` +
    `Open ${APP_URL} and sign in with this email address to accept the ` +
    `invitation.`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:32px;">
          <h1 style="margin:0 0 16px;font-size:20px;">You're invited to ${org}</h1>
          <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">
            You have been invited to join <strong>${org}</strong> as <strong>${safeRole}</strong>.
          </p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.5;">
            Sign in with this email address to accept the invitation.
          </p>
          <a href="${APP_URL}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;">
            Accept invitation
          </a>
          <p style="margin:24px 0 0;font-size:13px;color:#888;line-height:1.5;">
            If you weren't expecting this, you can safely ignore this email.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

// Build and send the invitation email for a (human) agent row via Resend.
// Shared by both the database-trigger path and the owner-initiated resend path.
async function sendEmail(agent: AgentRow | undefined): Promise<Response> {
  const invitation = (agent?.extra as HumanAgentExtra | null)?.invitation;

  if (!agent || !invitation?.email) {
    // Nothing to send (e.g. an AI agent or an owner row slipped through).
    return new Response("No invitation email to send", {
      headers: corsHeaders,
    });
  }

  const role = (agent.extra as HumanAgentExtra).role ?? "member";
  const { subject, text, html } = buildEmail(
    invitation.organization_name,
    role,
  );

  log.info(
    `Sending invitation email to ${invitation.email} for agent ${agent.id}`,
  );

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: INVITATION_FROM_EMAIL,
      to: invitation.email,
      subject,
      text,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Resend rejected the invitation email (${res.status}): ${body}`,
    );
  }

  return new Response("Invitation email sent", { headers: corsHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!RESEND_API_KEY || !INVITATION_FROM_EMAIL) {
      throw new Error(
        "Email sending is not configured: set RESEND_API_KEY and " +
          "INVITATION_FROM_EMAIL.",
      );
    }

    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    // Trigger path: the database webhook authenticates with the service role key
    // and sends the freshly-inserted agent row in the webhook payload.
    if (token === SERVICE_ROLE_KEY) {
      const agent = ((await req.json()) as WebhookPayload<AgentRow>).record;
      return await sendEmail(agent);
    }

    // Authenticated owner path: an owner clicks "Resend invitation" in the UI.
    // The request carries the user's JWT; we re-derive the recipient, role, and
    // organization from the database so the caller cannot spoof any of them.
    const supabase = createClient(req);

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response("Unauthorized", {
        status: 401,
        headers: corsHeaders,
      });
    }

    const { agent_id } = (await req.json()) as { agent_id?: string };
    if (!agent_id) {
      return new Response("Missing agent_id", {
        status: 400,
        headers: corsHeaders,
      });
    }

    // RLS lets any org member read agents, so this fetch alone is NOT
    // authorization — we enforce the owner check explicitly below.
    const { data: agent } = await supabase
      .from("agents")
      .select()
      .eq("id", agent_id)
      .maybeSingle();

    const invitation = (agent?.extra as HumanAgentExtra | null)?.invitation;
    if (!agent || agent.ai || invitation?.status !== "pending" ||
        !invitation?.email) {
      return new Response("No pending invitation to resend", {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Authorize: the caller must be an owner of the invitation's organization.
    const { data: caller } = await supabase
      .from("agents")
      .select("extra")
      .eq("organization_id", agent.organization_id)
      .eq("user_id", user.id)
      .maybeSingle();

    const callerRole = (caller?.extra as HumanAgentExtra | null)?.role;
    if (callerRole !== "owner") {
      return new Response("Owner role required", {
        status: 403,
        headers: corsHeaders,
      });
    }

    return await sendEmail(agent as AgentRow);
  } catch (err) {
    log.error("Failed to send invitation email", err);
    return errorHandler(err);
  }
});
