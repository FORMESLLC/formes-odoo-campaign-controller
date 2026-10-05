// Intentionally disabled in source control.
//
// Odoo session credentials must not be extracted from a browser or committed to GitHub.
// Provision the secret directly into Supabase Vault under the unique name:
//   odoo_session_id
//
// The permanent controller reads that encrypted Vault secret at runtime.
// No campaign can send until this secret exists and the controller passes its dry-run audit.

Deno.serve(() => new Response("Bootstrap disabled", { status: 410 }));
