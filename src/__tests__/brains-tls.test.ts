import { rootCertificates } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { verbindungsWeg } from '../brains-tls.js';

// Brains-TLS Stufe 2: der MCP-Server nimmt den TLS-Port, sobald die API ihn
// nennt. Jede Probe waere gegen den Stand davor rot: der kannte nur
// tls_enabled und sprach mit verwalteten Brains immer Klartext.
const CA = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
const inst = { host: '49.13.38.27', port: 30183, tls_enabled: false };

describe('verbindungsWeg', () => {
  it('nimmt den TLS-Port mit eigener Stelle, wenn die API beides nennt', () => {
    const weg = verbindungsWeg(inst, { tls_enabled: false, tls_port: 30500, tls_ca: CA }, {});
    expect(weg.art).toBe('tls-eigene-stelle');
    expect(weg.port).toBe(30500);
    expect(weg.host).toBe('49.13.38.27');
    const ca = weg.tls?.ca as string[];
    expect(ca).toContain(CA);
    // Die System-Liste bleibt drin: ein spaeterer Wechsel auf ein
    // oeffentliches Zertifikat bricht dann nichts.
    expect(ca.length).toBe(rootCertificates.length + 1);
  });

  it('bleibt beim Klartext, solange die API keinen TLS-Port nennt', () => {
    const weg = verbindungsWeg(inst, { tls_enabled: false }, {});
    expect(weg).toEqual({ host: '49.13.38.27', port: 30183, art: 'klartext' });
  });

  it('nimmt keinen TLS-Port ohne Stelle (sonst scheiterte jede Verbindung an SELF_SIGNED)', () => {
    expect(verbindungsWeg(inst, { tls_enabled: false, tls_port: 30500 }, {}).art).toBe('klartext');
    expect(verbindungsWeg(inst, { tls_enabled: false, tls_port: 30500, tls_ca: 'kein pem' }, {}).art).toBe('klartext');
  });

  it('BYOC mit rediss:// laeuft wie bisher ueber die System-Liste', () => {
    const weg = verbindungsWeg({ host: 'redis.kunde.de', port: 6380 }, { tls_enabled: true }, {});
    expect(weg).toEqual({ host: 'redis.kunde.de', port: 6380, tls: {}, art: 'tls-system' });
  });

  it('ohne Auskunft gilt tls_enabled der Instanz, Vorgabe TLS — wie vor Stufe 2', () => {
    expect(verbindungsWeg({ host: 'h', port: 1 }, undefined, {}).art).toBe('tls-system');
    expect(verbindungsWeg({ host: 'h', port: 1, tls_enabled: false }, undefined, {}).art).toBe('klartext');
  });

  it('CACHLY_BRAINS_TLS=aus ist der Notschalter zurueck zum alten Weg', () => {
    const weg = verbindungsWeg(inst, { tls_enabled: false, tls_port: 30500, tls_ca: CA }, { CACHLY_BRAINS_TLS: 'aus' });
    expect(weg.art).toBe('klartext');
    expect(weg.port).toBe(30183);
  });
});
