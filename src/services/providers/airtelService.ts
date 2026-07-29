import axios, { AxiosError } from "axios";
import { BaseProvider, ProviderAuthConfig } from "./baseProvider";
import { recordTelecomLatency } from "../../utils/logger";
import logger from "../../utils/logger";

interface AirtelTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

interface AirtelStatusResponse {
  data?: {
    transaction?: {
      status: string;
    };
  };
  status?: {
    success: boolean;
    code: string;
  };
}

export type AirtelTransactionStatus =
  | "completed"
  | "failed"
  | "pending"
  | "unknown";

export interface AirtelServiceConfig extends Partial<ProviderAuthConfig> {
  country?: string;
  currency?: string;
}

interface AirtelResolvedConfig extends ProviderAuthConfig {
  country: string;
  currency: string;
}

const POLL_DELAY_MS = 15_000;
const MAX_POLL_ATTEMPTS = 4;

let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
const pollEntries: Map<string, { reference: string; service: AirtelService; attempt: number }> = new Map();

function startPollProcessor(): void {
  if (pollTimeoutId !== null) return;
  if (pollEntries.size === 0) return;
  pollTimeoutId = setTimeout(async () => {
    pollTimeoutId = null;
    const batch = [...pollEntries.entries()];
    pollEntries.clear();
    for (const [, entry] of batch) {
      try {
        const result = await entry.service.getTransactionStatus(entry.reference);
        if (result.status === "pending" && entry.attempt < MAX_POLL_ATTEMPTS) {
          addPollEntry(entry.reference, entry.service, entry.attempt + 1);
        } else {
          logger.info(
            { reference: entry.reference, status: result.status, attempts: entry.attempt },
            "Airtel poll resolved transaction status",
          );
        }
      } catch (err) {
        logger.error(
          { reference: entry.reference, error: err instanceof Error ? err.message : err },
          "Airtel poll attempt failed, will retry",
        );
        if (entry.attempt < MAX_POLL_ATTEMPTS) {
          addPollEntry(entry.reference, entry.service, entry.attempt + 1);
        }
      }
    }
    startPollProcessor();
  }, POLL_DELAY_MS);
}

function addPollEntry(reference: string, service: AirtelService, attempt = 1): void {
  const key = `${reference}-${attempt}`;
  if (!pollEntries.has(key)) {
    pollEntries.set(key, { reference, service, attempt });
    startPollProcessor();
  }
}

function isNetworkTimeout(error: unknown): boolean {
  if (error instanceof AxiosError) {
    return (
      error.code === "ECONNABORTED" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNRESET" ||
      error.code === "ENOTFOUND" ||
      error.message?.toLowerCase().includes("timeout") ||
      error.message?.toLowerCase().includes("econnabort")
    );
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /timeout|econnabort|etimedout|econnreset|enotfound/i.test(msg);
}

function buildAirtelConfig(opts: AirtelServiceConfig = {}): AirtelResolvedConfig {
  return {
    apiKey: opts.apiKey ?? process.env.AIRTEL_API_KEY ?? "",
    apiSecret: opts.apiSecret ?? process.env.AIRTEL_API_SECRET ?? "",
    baseUrl: opts.baseUrl ?? process.env.AIRTEL_BASE_URL ?? "https://openapi.airtel.africa",
    timeoutMs: opts.timeoutMs ?? 10_000,
    country: opts.country ?? process.env.AIRTEL_COUNTRY ?? "NG",
    currency: opts.currency ?? process.env.AIRTEL_CURRENCY ?? "NGN",
  };
}

export class AirtelService extends BaseProvider {
  private readonly country: string;
  private readonly currency: string;
  private readonly providerName: string = "airtel";

  constructor(opts: AirtelServiceConfig = {}) {
    const config = buildAirtelConfig(opts);
    super(config);
    this.country = config.country;
    this.currency = config.currency;
  }

  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!;
    }

    const startTime = Date.now();
    const endpoint = "/auth/oauth2/token";
    try {
      const response = await axios.post<AirtelTokenResponse>(
        `${this.baseUrl}${endpoint}`,
        undefined,
        {
          headers: {
            Authorization: this.buildBasicAuthHeader(this.apiKey, this.apiSecret),
            "Content-Type": "application/json",
          },
          timeout: this.timeoutMs,
        },
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getAccessToken",
        durationMs,
        success: true,
        statusCode: response.status,
        endpoint,
      });

      const { access_token, expires_in } = response.data;
      if (!access_token || typeof access_token !== "string") {
        throw new Error("Airtel token response did not include access_token");
      }

      this.cacheToken(access_token, expires_in);
      return access_token;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const axiosError = error as AxiosError;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getAccessToken",
        durationMs,
        success: false,
        statusCode: axiosError?.response?.status,
        endpoint,
      });
      throw error;
    }
  }

  async requestPayment(phoneNumber: string, amount: string) {
    const startTime = Date.now();
    const endpoint = "/merchant/v1/payments/";
    const reference = `AIRTEL-${Date.now()}`;
    try {
      const token = await this.getAccessToken();
      const response = await axios.post(
        `${this.baseUrl}${endpoint}`,
        {
          reference,
          subscriber: {
            country: this.country,
            currency: this.currency,
            msisdn: phoneNumber,
          },
          transaction: {
            amount: parseFloat(amount),
            country: this.country,
            currency: this.currency,
            id: reference,
          },
        },
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
            "X-Country": this.country,
            "X-Currency": this.currency,
          },
          timeout: this.timeoutMs,
        },
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "requestPayment",
        durationMs,
        success: true,
        statusCode: response.status,
        endpoint,
      });

      return { success: true, data: response.data, reference };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const isTimeout = isNetworkTimeout(error);
      const axiosError = error as AxiosError;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "requestPayment",
        durationMs,
        success: isTimeout ? true : false,
        statusCode: isTimeout ? undefined : axiosError?.response?.status,
        endpoint,
      });

      if (isTimeout) {
        logger.warn(
          { reference, phoneNumber, amount, durationMs },
          "Airtel requestPayment timed out, scheduling status poll",
        );
        addPollEntry(reference, this);
        return { success: true, data: { reference, status: "pending" } };
      }

      return { success: false, error };
    }
  }

  async sendPayout(phoneNumber: string, amount: string) {
    const startTime = Date.now();
    const endpoint = "/standard/v1/disbursements/";
    const reference = `AIRTEL-PAYOUT-${Date.now()}`;
    try {
      const token = await this.getAccessToken();
      const response = await axios.post(
        `${this.baseUrl}${endpoint}`,
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
            "X-Country": this.country,
            "X-Currency": this.currency,
          },
          timeout: this.timeoutMs,
        },
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "sendPayout",
        durationMs,
        success: true,
        statusCode: response.status,
        endpoint,
      });

      return { success: true, data: response.data, reference };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const isTimeout = isNetworkTimeout(error);
      const axiosError = error as AxiosError;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "sendPayout",
        durationMs,
        success: isTimeout ? true : false,
        statusCode: isTimeout ? undefined : axiosError?.response?.status,
        endpoint,
      });

      if (isTimeout) {
        logger.warn(
          { reference, phoneNumber, amount, durationMs },
          "Airtel sendPayout timed out, scheduling status poll",
        );
        addPollEntry(reference, this);
        return { success: true, data: { reference, status: "pending" } };
      }

      return { success: false, error };
    }
  }

  async getTransactionStatus(
    reference: string,
  ): Promise<{ status: AirtelTransactionStatus }> {
    const startTime = Date.now();
    const endpoint = `/standard/v1/payments/${encodeURIComponent(reference)}`;
    try {
      const token = await this.getAccessToken();
      const response = await axios.get<AirtelStatusResponse>(
        `${this.baseUrl}${endpoint}`,
        {
          headers: {
            Authorization: this.buildBearerAuthHeader(token),
            "X-Country": this.country,
            "X-Currency": this.currency,
          },
          timeout: this.timeoutMs,
        },
      );

      const durationMs = Date.now() - startTime;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getTransactionStatus",
        durationMs,
        success: true,
        statusCode: response.status,
        endpoint: "/standard/v1/payments/{ref}",
      });

      const txStatus = String(response.data?.data?.transaction?.status ?? "").toUpperCase();
      if (txStatus === "TS") return { status: "completed" };
      if (txStatus === "TF") return { status: "failed" };
      if (txStatus === "TP") return { status: "pending" };
      return { status: "unknown" };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const isTimeout = isNetworkTimeout(error);
      const axiosError = error as AxiosError;
      recordTelecomLatency({
        provider: this.providerName,
        operation: "getTransactionStatus",
        durationMs,
        success: isTimeout ? true : false,
        statusCode: isTimeout ? undefined : axiosError?.response?.status,
        endpoint: "/standard/v1/payments/{ref}",
      });

      if (isTimeout) {
        logger.warn(
          { reference, durationMs },
          "Airtel getTransactionStatus timed out, scheduling poll retry",
        );
        addPollEntry(reference, this);
        return { status: "pending" };
      }

      return { status: "unknown" };
    }
  }
}
