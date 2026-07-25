import crypto from "crypto";
import logger from "../utils/logger";

interface KeyEntry {
  version: string;
  key: string;
  createdAt: number;
}

const DEFAULT_ACTIVE_VERSION = "v1";
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

let keyStore: Map<string, KeyEntry> = new Map();
let activeVersion: string = DEFAULT_ACTIVE_VERSION;

function initFromEnv(): void {
  keyStore.clear();

  const secretsRaw = process.env.JWT_SECRETS;
  if (secretsRaw) {
    try {
      const parsed: Record<string, string> = JSON.parse(secretsRaw);
      for (const [version, key] of Object.entries(parsed)) {
        keyStore.set(version, { version, key, createdAt: Date.now() });
      }
    } catch {
      logger.warn("[jwtKeys] Failed to parse JWT_SECRETS JSON");
    }
  }

  const legacy = process.env.JWT_SECRET;
  if (legacy && !keyStore.has(DEFAULT_ACTIVE_VERSION)) {
    keyStore.set(DEFAULT_ACTIVE_VERSION, {
      version: DEFAULT_ACTIVE_VERSION,
      key: legacy,
      createdAt: Date.now(),
    });
  }

  activeVersion = process.env.ACTIVE_JWT_KEY_VERSION || DEFAULT_ACTIVE_VERSION;
  if (!keyStore.has(activeVersion)) {
    activeVersion = DEFAULT_ACTIVE_VERSION;
  }

  if (keyStore.size === 0) {
    const initialKey = crypto.randomBytes(32).toString("hex");
    keyStore.set(DEFAULT_ACTIVE_VERSION, {
      version: DEFAULT_ACTIVE_VERSION,
      key: initialKey,
      createdAt: Date.now(),
    });
    activeVersion = DEFAULT_ACTIVE_VERSION;
    logger.warn(
      { version: DEFAULT_ACTIVE_VERSION },
      "[jwtKeys] No JWT secrets found — generated ephemeral signing key",
    );
  }
}

export function getActiveSigningKey(): { key: string; kid: string } {
  if (keyStore.size === 0) {
    initFromEnv();
  }
  const entry = keyStore.get(activeVersion);
  if (!entry) {
    throw new Error(
      `Active JWT key version "${activeVersion}" not found in key store`,
    );
  }
  return { key: entry.key, kid: entry.version };
}

export function getVerificationKeys(): { key: string; kid: string }[] {
  if (keyStore.size === 0) {
    initFromEnv();
  }
  const results: { key: string; kid: string }[] = [];
  const activeTs = keyStore.get(activeVersion)?.createdAt ?? 0;

  for (const [, entry] of keyStore) {
    const age = Date.now() - entry.createdAt;
    if (entry.version === activeVersion || age < GRACE_PERIOD_MS) {
      results.push({ key: entry.key, kid: entry.version });
    }
  }

  if (results.length === 0) {
    throw new Error("No JWT verification keys available");
  }

  results.sort((a, b) => {
    const aIsActive = a.kid === activeVersion ? 1 : 0;
    const bIsActive = b.kid === activeVersion ? 1 : 0;
    return bIsActive - aIsActive;
  });

  return results;
}

export async function rotateKey(): Promise<{ oldKid: string; newKid: string }> {
  if (keyStore.size === 0) {
    initFromEnv();
  }

  const newVersionNum =
    Math.max(
      0,
      ...Array.from(keyStore.keys()).map((v) => {
        const n = parseInt(v.replace(/^v/i, ""), 10);
        return isNaN(n) ? 0 : n;
      }),
    ) + 1;
  const newVersion = `v${newVersionNum}`;
  const newKey = crypto.randomBytes(32).toString("hex");

  const oldKid = activeVersion;

  keyStore.set(newVersion, {
    version: newVersion,
    key: newKey,
    createdAt: Date.now(),
  });
  activeVersion = newVersion;

  const staleKeys: string[] = [];
  for (const [version, entry] of keyStore) {
    if (version !== activeVersion && Date.now() - entry.createdAt >= GRACE_PERIOD_MS) {
      staleKeys.push(version);
    }
  }
  for (const version of staleKeys) {
    keyStore.delete(version);
  }

  logger.warn(
    {
      oldKid,
      newKid: activeVersion,
      staleKeysRemoved: staleKeys.length,
      activeKeysRemaining: keyStore.size,
    },
    "[JWT-KeyRotation] JWT signing key rotated",
  );

  return { oldKid, newKid: activeVersion };
}

export function resetStore(): void {
  keyStore.clear();
  activeVersion = DEFAULT_ACTIVE_VERSION;
}

initFromEnv();
