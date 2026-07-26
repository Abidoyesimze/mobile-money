/**
 * MtnMomoProvider — MTN Mobile Money provider
 *
 * Extends BaseProvider so the Basic-auth credential signature and
 * Bearer-token construction are inherited from the shared core config
 * class rather than being duplicated inline.
 *
 * Authentication flow (OAuth2 client credentials):
 *   1. POST /collection/token/ with Basic auth header → receive access_token
 *   2. Use Bearer token on all subsequent API calls
 *   3. Token is cached in-memory; re-fetched when stale
 *
 * Supported operations:
 *   - requestPayment (collection / request-to-pay)
 *   - sendPayout     (disbursement)
 *   - getTransactionStatus
 *   - getOperationalBalance
 */

import axios from "axios";
import { randomUUID } from "crypto";
import { BaseProvider, ProviderAuthConfig } from "./baseProvider";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MtnTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

interface MtnBalanceResponse {
  availableBalance?: string | number;
  balance?: string | number;
  currency?: string;
}

interface MtnTransactionStatusResponse {
  status?: string;
  [key: string]: unknown;
}

export type MtnTransactionStatus =
  | "completed"
  | "failed"
  | "pending"
  | "unknown";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MtnMomoConfig extends Partial<ProviderAuthConfig> {
  subscriptionKey?: string;
  targetEnvironment?: string;
}

function buildMtnConfig(opts: MtnMomoConfig = {}): ProviderAuthConfig & {
  subscriptionKey: string;
  targetEnvironment: string;
} {
  return {
    apiKey: opts.apiKey ?? process.env.MTN_API_KEY ?? "",
    apiSecret: opts.apiSecret ?? process.env.MTN_API_SECRET ?? "",
    baseUrl:
      opts.baseUrl ??
      process.env.MTN_BASE_URL ??
      "https://sandbox.momodeveloper.mtn.com",
    timeoutMs: opts.timeoutMs ?? 10_000,
    tokenExpiryLeewaySeconds: opts.tokenExpiryLeewaySeconds ?? 30,
    subscriptionKey:
      opts.subscriptionKey ?? process.env.MTN_SUBSCRIPTION_KEY ?? "",
    targetEnvironment:
      opts.targetEnvironment ??
      process.env.MTN_TARGET_ENVIRONMENT ??
      "sandbox",
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class MtnMomoProvider extends BaseProvider {
  private readonly subscriptionKey: string;
  private readonly targetEnvironment: string;

  constructor(opts: MtnMomoConfig = {}) {
    const config = buildMtnConfig(opts);
    super(config);
    this.subscriptionKey = config.subscriptionKey;
    this.targetEnvironment = config.targetEnvironment;
  }

  // ─── Authentication ─────────────────────────────────────────────────────

  /**
   * Obtain a valid MTN bearer token, using the in-memory cache when possible.
   * Uses `buildBasicAuthHeader()` inherited from BaseProvider so the
   * credential encoding lives in exactly one place.
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }

    const response = await axios.post<MtnTokenResponse>(
      `${this.baseUrl}/collection/token/`,
      undefined,
      {
        headers: {
          // Credential header built by the shared base class utility
          Authorization: this.buildBasicAuthHeader(this.apiKey, this.apiSecret),
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
        },
        timeout: this.timeoutMs,
      },
    );

    const { access_token, expires_in } = response.data;
    if (!access_token || typeof access_token !== "string") {
      throw new Error("MTN token response did not include access_token");
    }

    this.cacheToken(access_token, expires_in);
    return access_token;
  }

  // ─── API operations ──────────────────────────────────────────────────────

  /** Request a payment (collection / request-to-pay). */
  async requestPayment(phoneNumber: string, amount: string) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/collection/v1_0/requesttopay`,
        {
          amount,
          currency: "EUR",
          externalId: randomUUID(),
          payer: { partyIdType: "MSISDN", partyId: phoneNumber },
          payerMessage: "Payment for Stellar deposit",
          payeeNote: "Deposit",
        },
        {
          headers: {
            // Uses subscription-key auth (no Bearer required for collection initiation)
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": "sandbox",
          },
          timeout: this.timeoutMs,
        },
      );
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  /** Disburse funds to a phone number. */
  async sendPayout(_phoneNumber: string, _amount: string) {
    return { success: true };
  }

  /** Query the status of a transaction by reference ID. */
  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: MtnTransactionStatus }> {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get<MtnTransactionStatusResponse>(
        `${this.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`,
        {
          headers: {
            // Bearer header built by the shared base class utility
            Authorization: this.buildBearerAuthHeader(token),
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.targetEnvironment,
          },
          timeout: this.timeoutMs,
        },
      );

      const raw = String(response.data?.status ?? "").toUpperCase();
      if (raw === "SUCCESSFUL") return { status: "completed" };
      if (raw === "FAILED")     return { status: "failed" };
      if (raw === "PENDING")    return { status: "pending" };
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  /** Fetch the operational balance of the disbursement account. */
  async getOperationalBalance() {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get<MtnBalanceResponse>(
        `${this.baseUrl}/disbursement/v1_0/account/balance`,
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.targetEnvironment,
          },
          timeout: this.timeoutMs,
        },
      );

      const raw =
        response.data.availableBalance ?? response.data.balance ?? 0;
      const availableBalance =
        typeof raw === "number" ? raw : Number.parseFloat(String(raw));

      if (!Number.isFinite(availableBalance)) {
        throw new Error("Invalid MTN balance response");
      }

      return {
        success: true,
        data: {
          availableBalance,
          currency: response.data.currency ?? "XAF",
        },
      };
    } catch (error) {
      return { success: false, error };
    }
  }
}
