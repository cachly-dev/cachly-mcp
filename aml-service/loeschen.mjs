// Leert ALLE Datenbanken des AML-Valkey (aml-valkey, 127.0.0.1:6391) samt Zuordnung user_id -> DB.
// AML verlangt Loeschung binnen 30 Tagen.   node sdk/mcp/aml-service/loeschen.mjs --ja
import { Redis } from './kern.mjs';
const url = process.env.AML_REDIS_URL ?? 'redis://127.0.0.1:6391';
if (!/^redis:\/\/(127\.0\.0\.1|localhost):6391\b/.test(url)) { console.error('Nur der aml-valkey auf Port 6391 wird geleert.'); process.exit(2); }
if (!process.argv.includes('--ja')) { console.error('Sicherung: mit --ja starten.'); process.exit(2); }
const r = new Redis(url);
const vorher = Number(await r.hlen('aml:dbmap'));
await r.flushall();
console.log(`geleert: ${vorher} user_id-Zuordnungen und alle Datenbanken entfernt`);
await r.quit();
