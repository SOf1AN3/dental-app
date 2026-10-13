import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/db";
import { devices } from "@/lib/db/schema";
import { evaluateTrust } from "./device-trust";
import { createDeviceTrustRepo } from "./device-trust-db";

/**
 * Test d'intégration du contrat **MERGE** de `device-trust-db.ts` contre la
 * base de dev (127.0.0.1:5432) — tâche 3.2, vérification 6.
 *
 * Scénario (deviceId jetable `test-merge-<uuid>`, nettoyage en `finally`) :
 * (a) création de la ligne ;
 * (b) pose d'une révocation, puis upsert **sans** `trustRevokedAt` → la
 *     révocation doit **survivre** (un upsert remplaçant l'effacerait =
 *     fail-open) ;
 * (c) upsert sans `firstSeenAt` (jamais fourni par le type) → la date initiale
 *     doit survivre ;
 * (d) `get`/`touch` : `touch` ne met à jour que `lastSeenAt`.
 *
 * **Skippé sans base** : la sonde `SELECT … FROM device` échoue si la base de
 * dev est absente ou non migrée → `describe.skip`, la suite hermétique (252
 * tests) ne régresse jamais à cause de cette DB.
 *
 * Note de timezone : les comparaisons portent sur des valeurs **relues depuis
 * la base** (mêmes allers-retours), jamais sur une écriture JS brute — le
 * mappage `timestamp`/`Date` décale sinon l'horloge selon le fuseau local.
 */

async function isDeviceTableReachable(): Promise<boolean> {
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1 from device limit 1`),
      new Promise<never>((_, reject) => {
        probeTimer = setTimeout(
          () => reject(new Error("timeout connectivité")),
          3000,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    // Le timer doit être libéré dans TOUS les cas (réussite comme échec) :
    // sans `clearTimeout`, la Promise perdue de la course retiendrait le
    // process jusqu'à l'échéance des 3 s.
    clearTimeout(probeTimer);
  }
}

const dbReachable = await isDeviceTableReachable();
const describeWithDb = dbReachable ? describe : describe.skip;

/** Fermeture propre du client partagé : aucune socket ouverte à la sortie. */
afterAll(async () => {
  await db.$client.end({ timeout: 1 });
});

describeWithDb("device-trust-db — merge SQL contre la base de dev", () => {
  it(
    "préserve first_seen_at et trust_revoked_at à travers les upserts",
    async () => {
      const repo = createDeviceTrustRepo();
      const deviceId = `test-merge-${randomUUID()}`;
      try {
        // (a) création — premier octroi.
        const created = await repo.upsert(deviceId, {
          name: "merge-host",
          os: "win32",
          trustExpiresAt: new Date("2026-06-01T00:00:00.000Z"),
          lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        expect(created.id).toBe(deviceId);
        expect(created.trustRevokedAt).toBeNull();
        const initialFirstSeen = created.firstSeenAt;

        // (b) révocation posée (équivalent local de revokeTrustLocally).
        const revoked = await repo.upsert(deviceId, {
          trustRevokedAt: new Date("2026-02-01T00:00:00.000Z"),
        });
        expect(revoked.trustRevokedAt).not.toBeNull();

        // Upsert SANS trustRevokedAt (cas d'un grantTrust subséquent) : la
        // révocation et first_seen_at doivent **survivre**, la confiance fuse.
        const merged = await repo.upsert(deviceId, {
          trustExpiresAt: new Date("2026-07-01T00:00:00.000Z"),
        });
        expect(merged.trustRevokedAt).toEqual(revoked.trustRevokedAt);
        expect(merged.firstSeenAt).toEqual(initialFirstSeen);
        expect(merged.trustExpiresAt).not.toEqual(created.trustExpiresAt);

        // Échec fermé : la révocation prime sur la nouvelle expiration.
        expect(evaluateTrust(merged, "user-quelconque", new Date())).toEqual({
          ok: false,
          reason: "revoked",
        });

        // (c) relecture indépendante : même garanties côté `get`.
        const got = await repo.get(deviceId);
        expect(got?.trustRevokedAt).toEqual(revoked.trustRevokedAt);
        expect(got?.firstSeenAt).toEqual(initialFirstSeen);

        // (d) touch : seul lastSeenAt avance (valeur relue = valeur écrite).
        const before = await repo.get(deviceId);
        const touchedAt = new Date("2030-03-01T00:00:00.000Z");
        await repo.touch(deviceId, touchedAt);
        const touched = await repo.get(deviceId);
        expect(touched?.lastSeenAt).toEqual(touchedAt);
        expect(touched?.firstSeenAt).toEqual(initialFirstSeen);
        expect(touched?.trustRevokedAt).toEqual(revoked.trustRevokedAt);
        // Rien d'autre n'a bougé : la confiance reste révoquée, l'expiration aussi.
        expect(touched?.trustExpiresAt).toEqual(before?.trustExpiresAt);
      } finally {
        // Nettoyage : jamais de ligne de test résiduelle.
        await db.delete(devices).where(eq(devices.id, deviceId));
      }
    },
    15000,
  );
});
