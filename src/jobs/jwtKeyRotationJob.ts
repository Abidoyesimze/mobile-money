import logger from "../utils/logger";
import { rotateKey } from "../auth/jwtKeys";

export async function runJwtKeyRotationJob(): Promise<void> {
  logger.info("[JWT-KeyRotation] Monthly key rotation starting");

  try {
    const { oldKid, newKid } = await rotateKey();

    logger.warn(
      { oldKid, newKid },
      "[JWT-KeyRotation] Signing key rotated — old keys remain valid for 24-hour grace period",
    );
  } catch (err) {
    logger.error("[JWT-KeyRotation] Key rotation failed:", err);
    throw err;
  }
}
