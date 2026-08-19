import type { Redis } from 'ioredis';
import type { Instance } from './brain.js';

interface CreateResponse {
  instance_id: string;
  checkout_url?: string;
  status: string;
}

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const INSTANCE_TOOL_NAMES = new Set([
  'list_instances', 'create_instance', 'get_instance', 'get_connection_string', 'delete_instance',
  'list_orgs', 'create_org', 'invite_member', 'get_org_plan',
]);

function formatInstance(inst: Instance): string {
  const badge = inst.status === 'running' ? '🟢' : inst.status === 'provisioning' ? '🟡' : '🔴';
  const mb = inst.memory_mb >= 1024 ? `${inst.memory_mb / 1024}GB` : `${inst.memory_mb}MB`;
  return `${badge} **${inst.name}** (\`${inst.id}\`) · ${inst.tier} · ${mb} · ${inst.region}`;
}

/**
 * Baut eine Adresse aus einem Instanz-Datensatz.
 *
 * ── Warum diese Funktion NICHT mehr fuer get_connection_string benutzt wird ──
 *
 * Am 19.08.2026 gemessen: `get_connection_string` gab
 * `redis://49.13.38.27:30114` zurueck — ohne Passwort. Der mitgelieferte
 * "Quick test" (`redis-cli -u ... PING`) scheiterte sofort an NOAUTH. Ein
 * Werkzeug, das eine Verbindungsadresse verspricht und eine liefert, die nicht
 * verbindet.
 *
 * Die Funktion war nicht falsch. Sie bekam nur nie ein Passwort: sie wurde mit
 * dem Datensatz aus /api/v1/instances/:id gefuettert, und der fuehrt kein
 * Passwort — voellig richtig, das ist der allgemeine Instanz-Datensatz. Die
 * Zugangsdaten stehen unter /api/v1/instances/:id/connection, und dort baut der
 * Server die Adresse laengst fertig zusammen.
 *
 * Also gab es zwei Stellen, die wussten, wie eine Adresse aussieht — und nur
 * eine hatte alles, was dazugehoert. Dieselbe Fehlerklasse wie beim Export am
 * selben Tag: eine Frage aus einer Quelle bedient, die fuer eine andere gebaut
 * wurde.
 *
 * Sie bleibt fuer die Anzeige in Listen, wo bewusst kein Passwort hingehoert.
 */
function buildConnectionString(inst: Instance): string {
  if (!inst.host) return '❌ Instance not ready yet.';
  const proto = inst.tls_enabled ? 'rediss' : 'redis';
  const auth = inst.password ? `:${inst.password}@` : '';
  return `${proto}://${auth}${inst.host}:${inst.port ?? 6379}`;
}

export async function handleInstanceTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
    case 'list_instances': {
      const res = await apiFetch<{ data: Instance[] }>('/api/v1/instances');
      const instances = res.data ?? [];
      if (instances.length === 0)
        return 'You have no cache instances yet. Use `create_instance` to create one.';
      return [`Found ${instances.length} instance(s):\n`, ...instances.map(formatInstance)].join('\n');
    }

    case 'create_instance': {
      const { name: instName, tier } = args as { name: string; tier: string };
      const res = await apiFetch<CreateResponse>('/api/v1/instances', {
        method: 'POST',
        body: JSON.stringify({ name: instName, tier, created_via: 'api' }),
      });
      if (res.checkout_url) {
        return [
          `✅ Instance **${instName}** (${tier}) created! ID: \`${res.instance_id}\``,
          ``,
          `💳 This is a paid tier. Complete payment to activate:`,
          `   ${res.checkout_url}`,
          ``,
          `After payment, provisioning starts automatically (~30 seconds).`,
        ].join('\n');
      }
      return [
        `✅ Instance **${instName}** (${tier}) created and provisioning started!`,
        `   ID: \`${res.instance_id}\``,
        `   Status: ${res.status}`,
        ``,
        `Use \`get_instance\` or \`get_connection_string\` to get your connection details.`,
      ].join('\n');
    }

    case 'get_instance': {
      const inst = await apiFetch<Instance>(`/api/v1/instances/${(args as { instance_id: string }).instance_id}`);
      return formatInstance(inst);
    }

    case 'get_connection_string': {
      const inst = await apiFetch<Instance>(`/api/v1/instances/${(args as { instance_id: string }).instance_id}`);
      if (inst.status !== 'running') {
        return `Instance is not running yet (status: ${inst.status}). Provisioning takes ~30 seconds after payment.`;
      }
      // Die Adresse kommt vom Server, nicht von hier. Er hat als einziger das
      // Passwort (verschluesselt in der Datenbank, dort entschluesselt) und
      // baut die Zeichenkette bereits vollstaendig zusammen.
      let conn: { connection_string?: string; password?: string } = {};
      let konnteNichtFragen = false;
      try {
        conn = await apiFetch<{ connection_string?: string; password?: string }>(
          `/api/v1/instances/${(args as { instance_id: string }).instance_id}/connection`,
        );
      } catch {
        // Aeltere oder eingeschraenkte Server. Dann bleibt nur der allgemeine
        // Datensatz — der fuehrt kein Passwort. Das ist kein Grund
        // abzubrechen, aber ein Grund, es dazuzuschreiben.
        konnteNichtFragen = true;
      }
      const connStr = conn.connection_string || buildConnectionString(inst);

      // Eine Adresse ohne Passwort ist gegen ein passwortgeschuetztes Valkey
      // nutzlos — sie scheitert mit NOAUTH, und zwar erst beim Nutzer. Deshalb
      // steht der Hinweis hier, ueber der Adresse, nicht in einer Fussnote.
      const ohnePasswort = !connStr.includes('@');
      const warnung = !ohnePasswort ? [] : konnteNichtFragen
        ? ['⚠️  Could not read the credentials endpoint — this string has NO password and will fail with NOAUTH if the instance requires one.', '']
        : conn.password
          ? ['⚠️  The server returned a password but this string carries none — please report this.', '']
          : [];

      return [
        ...warnung,
        `**Connection string for ${inst.name}:**`,
        `\`\`\``,
        connStr,
        `\`\`\``,
        ``,
        `**Environment variable:**`,
        `\`\`\`bash`,
        `REDIS_URL="${connStr}"`,
        `CACHLY_URL="${connStr}"`,
        `\`\`\``,
        ``,
        `**Quick test:**`,
        `\`\`\`bash`,
        `redis-cli -u "${connStr}" PING`,
        `\`\`\``,
      ].join('\n');
    }

    case 'delete_instance': {
      const { instance_id, confirm } = args as { instance_id: string; confirm: boolean };
      if (!confirm) return 'Deletion cancelled. Set `confirm: true` to proceed.';
      // Clean up cached connection (best-effort; connection times out otherwise)
      try { (getConnection as unknown as { _pool?: Map<string, unknown> })._pool?.delete?.(instance_id); } catch { /* ignore */ }
      await apiFetch(`/api/v1/instances/${instance_id}`, { method: 'DELETE' });
      return `✅ Instance \`${instance_id}\` has been deleted and all data removed.`;
    }

    // ── Org / Team management ────────────────────────────────────────────
    case 'list_orgs': {
      const res = await apiFetch<{ orgs: Array<{ id: string; name: string; slug: string; plan: string; max_members: number; member_count?: number }> }>('/api/v1/orgs');
      const orgs = res.orgs ?? [];
      if (orgs.length === 0) return `📭 No organizations yet.\n\nCreate one with \`create_org(name="My Team")\`.\nOrg plans: Team €99/mo (10 seats), Business €299/mo (50 seats), Enterprise custom.`;
      return [
        `🏢 **Your organizations (${orgs.length})**\n`,
        ...orgs.map(o => `• **${o.name}** (\`${o.slug}\`) — plan: ${o.plan} · seats: ${o.member_count ?? '?'}/${o.max_members}\n  ID: \`${o.id}\``),
        `\n_Manage: \`get_org_plan\`, \`invite_member\`, dashboard → /team_`,
      ].join('\n');
    }

    case 'create_org': {
      const { name: orgName, slug } = args as { name: string; slug?: string };
      const body: Record<string, string> = { name: orgName };
      if (slug) body.slug = slug;
      const res = await apiFetch<{ id: string; name: string; slug: string; plan: string }>('/api/v1/orgs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return [
        `✅ **Organization created:** ${res.name}`,
        `   ID: \`${res.id}\` · Slug: \`${res.slug}\` · Plan: ${res.plan}`,
        ``,
        `**Next steps:**`,
        `1. Invite team members: \`invite_member(org_id="${res.id}", email="dev@example.com")\``,
        `2. Upgrade plan: open billing portal via dashboard → /team`,
        `   Team: €99/mo (10 seats) · Business: €299/mo (50 seats)`,
      ].join('\n');
    }

    case 'invite_member': {
      const { org_id, email, role = 'member' } = args as { org_id: string; email: string; role?: string };
      await apiFetch(`/api/v1/orgs/${org_id}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, role }),
      });
      return `✅ Invite sent to **${email}** as \`${role}\` in org \`${org_id}\`.\n\nThey will receive an email to join the organization.`;
    }

    case 'get_org_plan': {
      const { org_id } = args as { org_id: string };
      const org = await apiFetch<{
        id: string; name: string; plan: string; max_members: number;
        members: Array<{ role: string; invite_email: string; accepted_at?: string }>;
        stripe_customer_id?: string;
      }>(`/api/v1/orgs/${org_id}`);
      const accepted = (org.members ?? []).filter(m => m.accepted_at).length;
      const pending = (org.members ?? []).filter(m => !m.accepted_at).length;
      const planPrice: Record<string, string> = { free: '€0', team: '€99/mo', business: '€299/mo', enterprise: 'custom' };
      return [
        `🏢 **${org.name}** — Plan: **${org.plan}** (${planPrice[org.plan] ?? org.plan})`,
        `   Seats: ${accepted} active + ${pending} pending / ${org.max_members} max`,
        ``,
        `**Members:**`,
        ...(org.members ?? []).map(m => `  • ${m.invite_email} (${m.role})${m.accepted_at ? '' : ' — pending'}`),
        ``,
        org.stripe_customer_id
          ? `💳 Billing: managed via Stripe. Upgrade/cancel: dashboard → /billing`
          : `💳 No payment method yet. Upgrade: dashboard → /billing → Team Plans`,
      ].join('\n');
    }

    // ── Live cache operations ────────────────────────────────────────────

    default:
      return null;
  }
}

export { formatInstance, buildConnectionString };
