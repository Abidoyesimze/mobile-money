/**
 * Rate Controller – Issue #1631
 *
 * Exposes HTTP endpoints for querying exchange rates that incorporate
 * the dynamic spread algorithm (liquidity depth + settlement time scaling).
 *
 * Routes (mounted at /api/rates):
 *   POST /api/rates/quote              – Get a dynamic-spread rate quote
 *   GET  /api/rates/spread/:provider   – Inspect current spread params for a provider
 *   POST /api/rates/spread/preview     – Preview spread without a full conversion
 */

import { Request, Response } from "express";
import { z } from "zod";
import {
  currencyService,
  SupportedCurrency,
  calculateAirtelFee,
  AIRTEL_FEE_TIERS,
} from "../services/currency";
import { dynamicSpreadService } from "../services/dynamicSpreadService";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Validation schemas
// ─────────────────────────────────────────────────────────────────────────────

const QuoteRequestSchema = z.object({
  /** Amount in the source currency */
  amount: z
    .number({ required_error: "amount is required" })
    .positive("amount must be positive"),
  /** Source currency code */
  from: z.string().min(3).max(3).toUpperCase(),
  /** Destination currency code */
  to: z.string().min(3).max(3).toUpperCase(),
  /** Mobile money provider identifier */
  provider: z.string().min(1, "provider is required"),
  /** Trade direction */
  direction: z.enum(["sell", "buy"]).optional().default("sell"),
  /** Optional: manually supply liquidity volume (USD) to override ledger query */
  liquidityVolumeUsd: z.number().nonnegative().optional(),
  /** Optional: manually supply settlement time (ms) to override provider_settings */
  settlementTimeMs: z.number().nonnegative().optional(),
});

const SpreadPreviewSchema = z.object({
  provider: z.string().min(1),
  /** Optional overrides for testing */
  liquidityVolumeUsd: z.number().nonnegative().optional(),
  settlementTimeMs: z.number().nonnegative().optional(),
});

const AirtelFeeQuoteSchema = z.object({
  amount: z
    .number({ required_error: "amount is required" })
    .nonnegative("amount must not be negative"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isSupportedCurrency(code: string): code is SupportedCurrency {
  return currencyService.isSupportedCurrency(code);
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

export class RateController {
  /**
   * POST /api/rates/quote
   *
   * Returns a rate quote that applies dynamic spread scaling based on
   * the provider's liquidity depth and settlement time.
   *
   * Request body:
   *   {
   *     amount: number,
   *     from: string,          // e.g. "NGN"
   *     to: string,            // e.g. "USD"
   *     provider: string,      // e.g. "mtn"
   *     direction?: "sell"|"buy",
   *     liquidityVolumeUsd?: number,   // optional override
   *     settlementTimeMs?: number      // optional override
   *   }
   *
   * Response:
   *   {
   *     success: true,
   *     data: {
   *       originalAmount, originalCurrency, convertedAmount,
   *       baseCurrency, rate, spread: { ... breakdown ... }
   *     }
   *   }
   */
  getDynamicRateQuote = async (req: Request, res: Response): Promise<void> => {
    const parsed = QuoteRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation error",
        details: parsed.error.issues,
      });
      return;
    }

    const {
      amount,
      from,
      to,
      provider,
      direction,
      liquidityVolumeUsd,
      settlementTimeMs,
    } = parsed.data;

    if (!isSupportedCurrency(from)) {
      res.status(400).json({
        success: false,
        error: `Unsupported source currency: ${from}`,
      });
      return;
    }

    if (!isSupportedCurrency(to)) {
      res.status(400).json({
        success: false,
        error: `Unsupported destination currency: ${to}`,
      });
      return;
    }

    try {
      const result = await currencyService.convertWithDynamicSpread(
        amount,
        from,
        to,
        provider,
        direction,
        { liquidityVolumeUsd, settlementTimeMs },
      );

      res.json({
        success: true,
        data: {
          originalAmount: result.originalAmount,
          originalCurrency: result.originalCurrency,
          convertedAmount: result.convertedAmount,
          baseCurrency: result.baseCurrency,
          rate: result.rate,
          spread: {
            spreadPct: result.spread.spreadPct,
            rawRate: result.spread.rawRate,
            adjustedRate: result.spread.adjustedRate,
            direction: result.spread.direction,
            provider: result.spread.provider,
            currencyPair: result.spread.currencyPair,
            calculatedAt: result.spread.calculatedAt,
            breakdown: result.spread.breakdown,
          },
        },
      });
    } catch (err) {
      logger.error({ err, from, to, provider }, "[RateController] Quote failed");
      res.status(500).json({
        success: false,
        error: "Failed to compute dynamic rate quote",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  /**
   * GET /api/rates/spread/:provider
   *
   * Returns the current spread parameters and effective spread percentage
   * for a given provider, without performing a full currency conversion.
   * Useful for dashboards, monitoring, and pre-trade inspection.
   *
   * Query params (optional overrides for manual testing):
   *   ?liquidityVolumeUsd=500000
   *   ?settlementTimeMs=15000
   */
  getSpreadParameters = async (req: Request, res: Response): Promise<void> => {
    const { provider } = req.params;

    if (!provider || provider.trim().length === 0) {
      res
        .status(400)
        .json({ success: false, error: "provider parameter is required" });
      return;
    }

    const liquidityVolumeUsd = req.query.liquidityVolumeUsd
      ? parseFloat(req.query.liquidityVolumeUsd as string)
      : undefined;

    const settlementTimeMs = req.query.settlementTimeMs
      ? parseFloat(req.query.settlementTimeMs as string)
      : undefined;

    try {
      const params = await dynamicSpreadService.getSpreadParameters(
        provider.trim().toLowerCase(),
        liquidityVolumeUsd,
        settlementTimeMs,
      );

      res.json({ success: true, data: params });
    } catch (err) {
      logger.error(
        { err, provider },
        "[RateController] Failed to fetch spread parameters",
      );
      res.status(500).json({
        success: false,
        error: "Failed to retrieve spread parameters",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  /**
   * POST /api/rates/spread/preview
   *
   * Preview spread parameters with optional manual overrides.
   * Allows engineering teams to simulate different liquidity/settlement
   * scenarios without hitting the database.
   *
   * Request body:
   *   {
   *     provider: string,
   *     liquidityVolumeUsd?: number,
   *     settlementTimeMs?: number
   *   }
   */
  previewSpread = async (req: Request, res: Response): Promise<void> => {
    const parsed = SpreadPreviewSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation error",
        details: parsed.error.issues,
      });
      return;
    }

    const { provider, liquidityVolumeUsd, settlementTimeMs } = parsed.data;

    try {
      const params = await dynamicSpreadService.getSpreadParameters(
        provider.trim().toLowerCase(),
        liquidityVolumeUsd,
        settlementTimeMs,
      );

      res.json({
        success: true,
        data: params,
        meta: {
          note: "Preview uses provided overrides; omitted fields are fetched from DB / provider_settings",
          overrides: {
            liquidityVolumeUsd:
              liquidityVolumeUsd !== undefined ? liquidityVolumeUsd : "from_ledger",
            settlementTimeMs:
              settlementTimeMs !== undefined ? settlementTimeMs : "from_provider_settings",
          },
        },
      });
    } catch (err) {
      logger.error(
        { err, provider },
        "[RateController] Spread preview failed",
      );
      res.status(500).json({
        success: false,
        error: "Failed to preview spread parameters",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  /**
   * POST /api/rates/airtel/fee
   *
   * Calculates the Airtel Money transaction fee and net amount for a given
   * gross amount using Airtel's tiered fee schedule (#1552).
   *
   * Request body:
   *   { amount: number }
   *
   * Response:
   *   { success: true, data: { grossAmount, fee, netAmount, tier, rate } }
   */
  calculateAirtelFeeQuote = (req: Request, res: Response): void => {
    const parsed = AirtelFeeQuoteSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation error",
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const data = calculateAirtelFee(parsed.data.amount);
      res.json({ success: true, data });
    } catch (err) {
      logger.error(
        { err, amount: parsed.data.amount },
        "[RateController] Airtel fee calculation failed",
      );
      res.status(500).json({
        success: false,
        error: "Failed to calculate Airtel fee",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  /**
   * GET /api/rates/airtel/fee-tiers
   *
   * Lists Airtel Money's tiered fee schedule so clients can preview rates
   * before submitting a transaction.
   */
  getAirtelFeeTiers = (_req: Request, res: Response): void => {
    res.json({ success: true, data: { tiers: AIRTEL_FEE_TIERS } });
  };
}

export const rateController = new RateController();
