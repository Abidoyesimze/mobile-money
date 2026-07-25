/**
 * AirtelService
 *
 * Extends BaseProvider so that the Basic-auth credential signature and
 * Bearer-token construction are inherited from the shared core config
 * class rather than being duplicated inline.
 *
 * Also fixes a pre-existing bug where the original `authenticate()` method
 * made two identical POST requests to `/auth/oauth2/token` — the outer call
 * was discarded and the inner call (inside a try/catch) was used instead.
 * The refactored implementation makes exactly one token request per refresh.
 */

import axios, { AxiosError, AxiosInstance } from "axios";
import {
  BaseProvider,
  ProviderAuthConfig,
} from "../../providers/baseProvider";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AirtelTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

interface AirtelResponse {
  data?: {
    transaction?: {
      status: string;
      id: string;
    };
  };
  status?: {
    success: boolean;
    code: string;
  };
}

interface AirtelBalanceResponse {
  data?: {
    balance?: string | number;
    availableBalance?: string | number;
    currency?: string;
  };
  balance?: string | number;
  availableBalance?: string | number;
  currency?: string;
}

// ─── Config builder ───────────────────────────────────────────────────────────

function buildConfig(): ProviderAuthConfig {
  return {
    apiKey: process.env.AIRTEL_API_KEY ?? "",
    apiSecret: process.env.AIRTEL_API_SECRET ?? "",
    baseUrl: process.env.AIRTEL_BASE_URL ?? "",
    timeoutMs: 10_000,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class AirtelService extends BaseProvider {
  private readonly client: AxiosInstance;

  constructor() {
    super(buildConfig());

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
    });
  }

  // ─── Authentication ─────────────────────────────────────────────────────

  /**
   * Obtain a valid Airtel bearer token, using the in-memory cache when
   * possible. Re-authenticates when the token is absent or stale.
   *
   * Fixes the previous double-POST bug: exactly one HTTP request is made
   * per token refresh, and the result is cached via the base-class helpers.
   * `buildBasicAuthHeader()` is inherited from BaseProvider.
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }

    try {
      const response = await this.client.post<AirtelTokenResponse>(
        "/auth/oauth2/token",
        null,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: this.buildBasicAuthHeader(this.apiKey, this.apiSecret),
          },
        },
      );

      const { access_token, expires_in } = response.data;
      this.cacheToken(access_token, expires_in);
      return access_token;
    } catch (error) {
      console.error("Airtel auth failed", error);
      throw new Error("Airtel authentication failed");
    }
  }

  // ─── Retry helper ────────────────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let lastError: Error | undefined;

    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        const axiosError = err as AxiosError;

        if (axiosError.response?.status === 401) {
          // Force token refresh on the next attempt
          this.invalidateToken();
        }

        if (
          (axiosError.response?.status !== undefined &&
            axiosError.response.status >= 500) ||
          (err as { code?: string }).code === "ECONNABORTED"
        ) {
          console.warn(`Retrying Airtel request (${i + 1})`);
          await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
          continue;
        }

        throw err;
      }
    }

    throw lastError;
  }

  // ─── API operations ──────────────────────────────────────────────────────

  async requestPayment(phoneNumber: string, amount: string) {
    const token = await this.getAccessToken();
    const reference = `AIRTEL-${Date.now()}`;

    return this.withRetry(async () => {
      try {
        const response = await this.client.post<AirtelResponse>(
          "/merchant/v1/payments/",
          {
            reference,
            subscriber: {
              country: process.env.AIRTEL_COUNTRY ?? "NG",
              currency: process.env.AIRTEL_CURRENCY ?? "NGN",
              msisdn: phoneNumber,
            },
            transaction: {
              amount: parseFloat(amount),
              country: process.env.AIRTEL_COUNTRY ?? "NG",
              currency: process.env.AIRTEL_CURRENCY ?? "NGN",
              id: reference,
            },
          },
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "X-Country": process.env.AIRTEL_COUNTRY ?? "NG",
              "X-Currency": process.env.AIRTEL_CURRENCY ?? "NGN",
            },
          },
        );

        return { success: true, data: response.data };
      } catch (error) {
        return { success: false, error };
      }
    });
  }

  async sendPayout(phoneNumber: string, amount: string) {
    const token = await this.getAccessToken();
    const reference = `AIRTEL-PAYOUT-${Date.now()}`;

    return this.withRetry(async () => {
      try {
        const response = await this.client.post<AirtelResponse>(
          "/standard/v1/disbursements/",
          {
            reference,
            payee: { msisdn: phoneNumber },
            transaction: {
              amount: parseFloat(amount),
              id: reference,
            },
          },
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "X-Country": process.env.AIRTEL_COUNTRY ?? "NG",
              "X-Currency": process.env.AIRTEL_CURRENCY ?? "NGN",
            },
          },
        );

        return { success: true, data: response.data };
      } catch (error) {
        return { success: false, error };
      }
    });
  }

  async getTransactionStatus(
    reference: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    try {
      const result = await this.checkStatus(reference);
      if (!result.success) return { status: "unknown" };
      const txStatus = String(
        (result.data as AirtelResponse)?.data?.transaction?.status ?? "",
      ).toUpperCase();
      // TS = success, TF = failed, TP = pending
      if (txStatus === "TS") return { status: "completed" };
      if (txStatus === "TF") return { status: "failed" };
      if (txStatus === "TP") return { status: "pending" };
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  async checkStatus(reference: string) {
    const token = await this.getAccessToken();

    return this.withRetry(async () => {
      try {
        const response = await this.client.get(
          `/standard/v1/payments/${reference}`,
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "X-Country": process.env.AIRTEL_COUNTRY ?? "NG",
              "X-Currency": process.env.AIRTEL_CURRENCY ?? "NGN",
            },
          },
        );
        return { success: true, data: response.data };
      } catch (error) {
        return { success: false, error };
      }
    });
  }

  async getOperationalBalance() {
    const token = await this.getAccessToken();

    return this.withRetry(async () => {
      try {
        const response = await this.client.get<AirtelBalanceResponse>(
          "/standard/v1/users/balance",
          {
            headers: {
              Authorization: this.buildBearerAuthHeader(token),
              "X-Country": process.env.AIRTEL_COUNTRY ?? "NG",
              "X-Currency": process.env.AIRTEL_CURRENCY ?? "NGN",
            },
          },
        );

        const rawBalance =
          response.data.data?.availableBalance ??
          response.data.data?.balance ??
          response.data.availableBalance ??
          response.data.balance ??
          0;

        const availableBalance =
          typeof rawBalance === "number"
            ? rawBalance
            : Number.parseFloat(String(rawBalance));

        if (!Number.isFinite(availableBalance)) {
          throw new Error("Invalid Airtel balance response");
        }

        return {
          success: true,
          data: {
            availableBalance,
            currency:
              response.data.data?.currency ??
              response.data.currency ??
              process.env.AIRTEL_CURRENCY ??
              "NGN",
          },
        };
      } catch (error) {
        return { success: false, error };
      }
    });
  }
}
