import postgres from "npm:postgres@3.4.5";

const BASE = "https://formessolutions.odoo.com";
const BOOTSTRAP_KEY = "f10a6e4c8485e5df6ed707ffe8684371d072c01273467fb83c28b43214928bd9";

async function validateOdooSession(sessionId: string) {
  const response = await fetch(`${BASE}/web/session/get_session_info`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `session_id=${sessionId}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {}, id: 1 }),
  });
  if (!response.ok) throw new Error(`Odoo HTTP ${response.status}`);
  const json = await response.json();
  if (!json?.result?.uid) throw new Error("Supplied Odoo session is not authenticated");
  return json.result.uid;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST required", { status: 405 });
  if (req.headers.get("x-bootstrap-key") !== BOOTSTRAP_KEY) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sessionId = String(body.sessionId || "");
  if (!sessionId) return new Response("sessionId required", { status: 400 });

  const uid = await validateOdooSession(sessionId);
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) return new Response("Database connection unavailable", { status: 500 });

  const sql = postgres(dbUrl, { max: 1, prepare: false });
  try {
    const existing = await sql`
      select id
      from vault.decrypted_secrets
      where name = 'odoo_session_id'
      order by created_at desc
      limit 1
    `;

    if (existing.length) {
      await sql`
        select vault.update_secret(
          ${existing[0].id}::uuid,
          ${sessionId},
          'odoo_session_id',
          'Authenticated Odoo web session for FORMES campaign controller'
        )
      `;
    } else {
      await sql`
        select vault.create_secret(
          ${sessionId},
          'odoo_session_id',
          'Authenticated Odoo web session for FORMES campaign controller'
        )
      `;
    }

    return Response.json({ ok: true, uid });
  } finally {
    await sql.end({ timeout: 2 });
  }
});
