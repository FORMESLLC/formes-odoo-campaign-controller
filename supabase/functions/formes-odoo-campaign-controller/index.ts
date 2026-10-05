import postgres from "npm:postgres@3.4.5";

const BASE = "https://formessolutions.odoo.com";
const CAMPAIGNS = Array.from({ length: 35 }, (_, i) => 72 + i);
const LIST_ID = 1;
const MAIL_SERVER_ID = 2;
const BATCH = 10;
const ATLAS = "https://www.formessolutions.com/services#technical-capability-atlas";
const LOCK_ID = 72051039;


function muscatParts() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Muscat",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return parts as Record<string, string>;
}

function muscatDate() {
  const p = muscatParts();
  return `${p.year}-${p.month}-${p.day}`;
}

async function odooRpc(sessionId: string, model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}) {
  const body = {
    jsonrpc: "2.0",
    method: "call",
    params: { model, method, args, kwargs },
    id: Math.floor(Math.random() * 1_000_000_000),
  };
  const response = await fetch(`${BASE}/web/dataset/call_kw/${model}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `session_id=${sessionId}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Odoo HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) {
    throw new Error(json?.error?.data?.message || json?.error?.message || JSON.stringify(json.error));
  }
  return json.result;
}

async function verifySession(sessionId: string) {
  const response = await fetch(`${BASE}/web/session/get_session_info`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `session_id=${sessionId}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {}, id: 1 }),
  });
  if (!response.ok) throw new Error(`Odoo session HTTP ${response.status}`);
  const json = await response.json();
  if (!json?.result?.uid) throw new Error("Odoo cloud session is not authenticated");
  return json.result.uid;
}

async function audience(sessionId: string) {
  const contacts = await odooRpc(
    sessionId,
    "mailing.contact",
    "search_read",
    [[
      ["list_ids", "in", [LIST_ID]],
      ["email_normalized", "!=", false],
      ["is_blacklisted", "=", false],
    ], ["id", "email_normalized"]],
    { limit: 5000, order: "id asc" },
  );

  const ids: number[] = contacts.map((x: any) => x.id);
  const optedOut = new Set<number>();
  for (let i = 0; i < ids.length; i += 500) {
    const subs = await odooRpc(
      sessionId,
      "mailing.subscription",
      "search_read",
      [[
        ["list_id", "=", LIST_ID],
        ["contact_id", "in", ids.slice(i, i + 500)],
        ["opt_out", "=", true],
      ], ["contact_id"]],
      { limit: 1000 },
    );
    for (const row of subs) optedOut.add(row.contact_id[0]);
  }
  return ids.filter((id) => !optedOut.has(id));
}

async function traces(sessionId: string, campaignId: number, recipientIds?: number[]) {
  const domain: any[] = [["mass_mailing_id", "=", campaignId]];
  if (recipientIds?.length) domain.push(["res_id", "in", recipientIds]);
  return await odooRpc(
    sessionId,
    "mailing.trace",
    "search_read",
    [domain, ["id", "res_id", "email", "trace_status", "sent_datetime", "failure_type", "failure_reason"]],
    { limit: recipientIds?.length ? 100 : 5000, order: "id asc" },
  );
}

async function validateCampaign(sessionId: string, campaignId: number) {
  const rows = await odooRpc(
    sessionId,
    "mailing.mailing",
    "read",
    [[campaignId], ["id", "name", "contact_list_ids", "mail_server_id", "attachment_ids", "body_arch"]],
    {},
  );
  const mailing = rows?.[0];
  if (!mailing) throw new Error(`Campaign ${campaignId} missing`);
  if (!mailing.contact_list_ids?.includes(LIST_ID)) throw new Error(`Campaign ${campaignId} wrong mailing list`);
  if (!mailing.mail_server_id || mailing.mail_server_id[0] !== MAIL_SERVER_ID) throw new Error(`Campaign ${campaignId} wrong SMTP server`);
  if (mailing.attachment_ids?.length) throw new Error(`Campaign ${campaignId} has attachment`);
  if (!String(mailing.body_arch || "").includes(ATLAS)) throw new Error(`Campaign ${campaignId} missing Atlas CTA`);
  return mailing;
}

async function recheckBatch(sessionId: string, ids: number[]) {
  const contacts = await odooRpc(
    sessionId,
    "mailing.contact",
    "read",
    [ids, ["id", "email_normalized", "is_blacklisted", "list_ids"]],
    {},
  );
  const byId = new Map<number, any>(contacts.map((x: any) => [x.id, x]));
  const subs = await odooRpc(
    sessionId,
    "mailing.subscription",
    "search_read",
    [[
      ["list_id", "=", LIST_ID],
      ["contact_id", "in", ids],
    ], ["contact_id", "opt_out"]],
    { limit: 100 },
  );
  const optedOut = new Set<number>(subs.filter((x: any) => x.opt_out).map((x: any) => x.contact_id[0]));
  const ok: number[] = [];
  const suppressed: number[] = [];

  for (const id of ids) {
    const x = byId.get(id);
    if (!x || !x.email_normalized || x.is_blacklisted || !x.list_ids?.includes(LIST_ID) || optedOut.has(id)) {
      suppressed.push(id);
    } else {
      ok.push(id);
    }
  }
  return { ok, suppressed };
}

function criticalFailure(trace: any) {
  const s = `${trace.failure_type || ""} ${trace.failure_reason || ""}`.toLowerCase();
  return /as\(42004\)|bad outbound sender|restricted from sending|outbound spam|5\.7\.708/.test(s);
}

async function getVaultSecret(sql: any, name: string) {
  const rows = await sql`
    select decrypted_secret
    from vault.decrypted_secrets
    where name = ${name}
    order by created_at desc
    limit 1
  `;
  return rows?.[0]?.decrypted_secret as string | undefined;
}

async function log(tx: any, level: string, event: string, details: unknown = null) {
  await tx`
    insert into campaign_ctrl.run_log (level, event, details)
    values (${level}, ${event}, ${details == null ? null : JSON.stringify(details)}::jsonb)
  `;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST required", { status: 405 });

  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) return new Response("Database connection unavailable", { status: 500 });

  const sql = postgres(dbUrl, { max: 1, prepare: false });

  try {
    const expectedKey = await getVaultSecret(sql, "formes_campaign_controller_key");
    const suppliedKey = req.headers.get("x-controller-key");
    if (!expectedKey || !suppliedKey || suppliedKey !== expectedKey) {
      return new Response("Unauthorized", { status: 401 });
    }

    const p = muscatParts();
    if (["Fri", "Sat"].includes(p.weekday)) {
      return Response.json({ ok: true, skipped: "Oman weekend" });
    }
    if (Number(p.hour) < 8) {
      return Response.json({ ok: true, skipped: "Before 08:00 Muscat" });
    }

    const sessionId = await getVaultSecret(sql, "odoo_session_id");
    if (!sessionId) return new Response("Odoo session not bootstrapped", { status: 503 });
    await verifySession(sessionId);

    const today = muscatDate();

    const result = await sql.begin(async (tx: any) => {
      const lockRows = await tx`select pg_try_advisory_xact_lock(${LOCK_ID}) as locked`;
      if (!lockRows?.[0]?.locked) return { ok: true, skipped: "Another controller invocation is active" };

      const controlRows = await tx`
        select paused, pause_reason, active_campaign_id, active_run_date::text as active_run_date
        from campaign_ctrl.control
        where id = true
        for update
      `;
      const control = controlRows[0];

      if (control.paused) {
        return { ok: false, paused: true, reason: control.pause_reason };
      }

      let campaignId: number;
      if (control.active_run_date === today && control.active_campaign_id) {
        campaignId = control.active_campaign_id;
      } else {
        let chosen: number | null = null;
        for (const candidate of CAMPAIGNS) {
          const rows = await tx`
            select completed_at
            from campaign_ctrl.campaigns
            where campaign_id = ${candidate}
          `;
          if (!rows.length || !rows[0].completed_at) {
            chosen = candidate;
            break;
          }
        }
        if (chosen == null) return { ok: true, complete: true, message: "All campaigns 05-39 complete" };
        campaignId = chosen;
        await tx`
          update campaign_ctrl.control
          set active_campaign_id = ${campaignId},
              active_run_date = ${today}::date,
              updated_at = now()
          where id = true
        `;
      }

      const campaignRows = await tx`
        select campaign_id, audience_json, suppressed_json, completed_at, failure_count_observed
        from campaign_ctrl.campaigns
        where campaign_id = ${campaignId}
        for update
      `;
      let state = campaignRows[0];

      if (state?.completed_at) {
        return { ok: true, dayComplete: true, campaignId };
      }

      const meta = await validateCampaign(sessionId, campaignId);

      if (!state) {
        await tx`
          insert into campaign_ctrl.campaigns (campaign_id)
          values (${campaignId})
          on conflict (campaign_id) do nothing
        `;
        state = {
          campaign_id: campaignId,
          audience_json: null,
          suppressed_json: "[]",
          completed_at: null,
          failure_count_observed: 0,
        };
      }

      let frozenAudience: number[];
      if (!state.audience_json) {
        frozenAudience = await audience(sessionId);
        await tx`
          update campaign_ctrl.campaigns
          set audience_json = ${JSON.stringify(frozenAudience)},
              snapshot_at = now(),
              remaining_count = ${frozenAudience.length},
              updated_at = now()
          where campaign_id = ${campaignId}
        `;
        await log(tx, "info", "audience_snapshot", { campaignId, count: frozenAudience.length, name: meta.name });
      } else {
        frozenAudience = JSON.parse(state.audience_json);
      }

      let suppressed: number[] = JSON.parse(state.suppressed_json || "[]");
      const traceRows = await traces(sessionId, campaignId);
      const done = new Set<number>(traceRows.map((t: any) => t.res_id));
      const suppressedSet = new Set<number>(suppressed);
      let remaining = frozenAudience.filter((id) => !done.has(id) && !suppressedSet.has(id));

      if (!remaining.length) {
        await tx`
          update campaign_ctrl.campaigns
          set completed_at = now(),
              final_trace_count = ${done.size},
              processed_count = ${done.size},
              remaining_count = 0,
              updated_at = now()
          where campaign_id = ${campaignId}
        `;
        await log(tx, "info", "campaign_complete", { campaignId, audience: frozenAudience.length, traces: done.size, suppressed: suppressedSet.size });
        return { ok: true, campaignComplete: true, campaignId };
      }

      const candidates = remaining.slice(0, BATCH);
      const eligibility = await recheckBatch(sessionId, candidates);

      for (const id of eligibility.suppressed) suppressedSet.add(id);
      if (eligibility.suppressed.length) {
        suppressed = [...suppressedSet];
        await tx`
          update campaign_ctrl.campaigns
          set suppressed_json = ${JSON.stringify(suppressed)},
              updated_at = now()
          where campaign_id = ${campaignId}
        `;
        await log(tx, "info", "pre_batch_suppression", { campaignId, ids: eligibility.suppressed });
      }

      let bad: any[] = [];
      if (eligibility.ok.length) {
        await odooRpc(sessionId, "mailing.mailing", "action_send_mail", [[campaignId], eligibility.ok], {});
        const batchTraces = await traces(sessionId, campaignId, eligibility.ok);
        const seen = new Set<number>(batchTraces.map((t: any) => t.res_id));
        const missing = eligibility.ok.filter((id) => !seen.has(id));
        if (missing.length) throw new Error(`Missing Odoo mailing traces for recipient ids: ${missing.join(",")}`);

        bad = batchTraces.filter((t: any) =>
          t.failure_type || ["error", "exception", "bounced"].includes(String(t.trace_status || "").toLowerCase())
        );

        await log(tx, "info", "batch_verified", {
          campaignId,
          sent: eligibility.ok.length,
          traceCount: batchTraces.length,
          failures: bad.length,
          firstRecipientId: eligibility.ok[0],
          lastRecipientId: eligibility.ok.at(-1),
        });

        if (bad.some(criticalFailure) || bad.length >= 3) {
          const reason = `Safety stop campaign ${campaignId}: ${bad.length} failed traces in batch`;
          await tx`
            update campaign_ctrl.control
            set paused = true,
                pause_reason = ${reason},
                paused_at = now(),
                updated_at = now()
            where id = true
          `;
          await tx`
            update campaign_ctrl.campaigns
            set last_failures = ${JSON.stringify(bad)}::jsonb,
                failure_count_observed = failure_count_observed + ${bad.length},
                last_batch_at = now(),
                updated_at = now()
            where campaign_id = ${campaignId}
          `;
          await log(tx, "critical", "safety_stop", { campaignId, reason, failures: bad });
          return { ok: false, paused: true, reason, campaignId };
        }
      }

      const refreshedTraces = await traces(sessionId, campaignId);
      const refreshedDone = new Set<number>(refreshedTraces.map((t: any) => t.res_id));
      remaining = frozenAudience.filter((id) => !refreshedDone.has(id) && !suppressedSet.has(id));

      await tx`
        update campaign_ctrl.campaigns
        set processed_count = ${refreshedDone.size},
            remaining_count = ${remaining.length},
            failure_count_observed = failure_count_observed + ${bad.length},
            last_batch_at = now(),
            updated_at = now()
        where campaign_id = ${campaignId}
      `;

      if (!remaining.length) {
        await tx`
          update campaign_ctrl.campaigns
          set completed_at = now(),
              final_trace_count = ${refreshedDone.size},
              updated_at = now()
          where campaign_id = ${campaignId}
        `;
        await log(tx, "info", "campaign_complete", { campaignId, audience: frozenAudience.length, traces: refreshedDone.size, suppressed: suppressedSet.size });
        return { ok: true, campaignComplete: true, campaignId };
      }

      return {
        ok: true,
        campaignId,
        campaignName: meta.name,
        processed: refreshedDone.size,
        suppressed: suppressedSet.size,
        remaining: remaining.length,
        batchSent: eligibility.ok.length,
      };
    });

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await sql`
        update campaign_ctrl.control
        set paused = true,
            pause_reason = ${"Controller exception: " + message},
            paused_at = now(),
            updated_at = now()
        where id = true
      `;
      await sql`
        insert into campaign_ctrl.run_log (level, event, details)
        values ('critical', 'controller_exception', ${JSON.stringify({ message })}::jsonb)
      `;
    } catch (_) {
      // Preserve the original controller error.
    }
    return Response.json({ ok: false, paused: true, error: message }, { status: 500 });
  } finally {
    await sql.end({ timeout: 2 });
  }
});
