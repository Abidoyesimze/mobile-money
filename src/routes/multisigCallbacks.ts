import { Router, Request, Response } from "express";
import { multisigCustodyLedgerService } from "../services/multisigCustodyLedgerService";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import logger from "../utils/logger";

const router = Router();
const mobileMoneyService = new MobileMoneyService();

router.post("/callback", async (req: Request, res: Response) => {
  const { requestId, signerId, signature, payload, publicKey } = req.body;

  if (!requestId || !signerId || !signature || !payload || !publicKey) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // 1. Verify webhook signature
    const isValid = multisigCustodyLedgerService.verifyWebhookSignature(
      payload,
      signature,
      publicKey,
    );

    if (!isValid) {
      logger.warn({ requestId, signerId }, "Invalid webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    // 2. Add signature to request
    const signResult = await multisigCustodyLedgerService.addSignature(
      requestId,
      signerId,
      signature,
      "webhook",
      req.ip,
      req.headers["user-agent"],
    );

    if (!signResult.success) {
      return res.status(400).json({ error: signResult.message });
    }

    // 3. If fully approved, execute payout
    if (signResult.fullyApproved) {
      // Get the request details
      const request =
        await multisigCustodyLedgerService.getRequestById(requestId);
      if (!request) {
        return res
          .status(404)
          .json({ error: "Request not found after approval" });
      }

      // Execute approved request in ledger
      const execResult =
        await multisigCustodyLedgerService.executeApprovedRequest(
          requestId,
          "system",
        );

      if (!execResult.success) {
        return res.status(500).json({ error: execResult.message });
      }

      // Execute the actual payout
      const provider = (request.metadata?.provider as string) || "mtn";
      const payoutResult = await mobileMoneyService.sendPayout(
        provider,
        request.destination,
        String(request.amount_xaf),
      );

      if (!payoutResult.success) {
        logger.error(
          { requestId, payoutResult },
          "Transaction payout execution failed",
        );
        return res.status(500).json({
          error: "Payout execution failed",
          details: payoutResult.error,
        });
      }

      return res.status(200).json({
        success: true,
        status: "executed",
        fullyApproved: true,
        message: "Request fully approved and payout executed successfully",
      });
    }

    return res.status(200).json({
      success: true,
      status: "pending",
      fullyApproved: false,
      message: "Signature added. Awaiting more signatures.",
    });
  } catch (error) {
    logger.error({ error, requestId }, "Error processing multisig callback");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
