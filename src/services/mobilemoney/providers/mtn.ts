/**
 * MTNProvider
 *
 * Extends BaseProvider so that the Basic-auth credential signature and
 * Bearer-token construction are inherited from the shared core config
 * class rather than being duplicated inline.
 *
 * Re-exported here for backwards compatibility — existing imports of
 * `MTNProvider` from this path continue to work unchanged.
 */

import axios from "axios";
import { randomUUID } from "crypto";
import {
  BaseProvider,
  ProviderAuthConfig,
} from "../../providers/baseProvider";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MtnTokenResponse {
  access_token: string;
  expires_in: number;
}

interface MtnBalanceResponse {
  availableBalance?: string | number;
  balance?: string | number;
  currency?: string;
}

// ─── Config builder ───────────────────────────────────────────────────────────

function buildConfig(): ProviderAuthConfig & {
  subscriptionKey: string;
  targetEnvironment: string;
} {
  return {
    apiKey: process.env.MTN_API_KEY ?? "",
    apiSecret: process.env.MTN_API_SECRET ?? "",
    baseUrl:
      process.env.MTN_BASE_URL ?? "https://sandbox.momodeveloper.mtn.com",
    timeoutMs: 10_000,
    subscriptionKey: process.env.MTN_SUBSCRIPTION_KEY ?? "",
    targetEnvironment: process.env.MTN_TARGET_ENVIRONMENT ?? "sandbox",
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class MTNProvider extends BaseProvider {
  private readonly subscriptionKey: string;
  private readonly environment: string;

  constructor() {
    const config = buildConfig();
    super(config);
    this.subscriptionKey = config.subscriptionKey;
    this.environment = config.targetEnvironment;
  }

  // ─── Authentication ─────────────────────────────────────────────────────

  /**
   * Obtain a valid MTN bearer token, using the in-memory cache when possible.
   * `buildBasicAuthHeader()` is inherited from BaseProvider.
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

  async getOperationalBalance() {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get<MtnBalanceResponse>(
        `${this.baseUrl}/disbursement/v1_0/account/balance`,
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.environment,
          },
        },
      );

      const availableRaw =
        response.data.availableBalance ?? response.data.balance ?? 0;
      const availableBalance =
        typeof availableRaw === "number"
          ? availableRaw
          : Number.parseFloat(String(availableRaw));

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
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": "sandbox",
          },
        },
      );

      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  async sendPayout(_phoneNumber: string, _amount: string) {
    return { success: true };
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(
        `${this.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`,
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
            "Ocp-Apim-Subscription-Key": this.subscriptionKey,
            "X-Target-Environment": this.environment,
          },
        },
      );

      const providerStatus = String(response.data?.status ?? "").toUpperCase();
      if (providerStatus === "SUCCESSFUL") return { status: "completed" };
      if (providerStatus === "FAILED")     return { status: "failed" };
      if (providerStatus === "PENDING")    return { status: "pending" };
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }
}
