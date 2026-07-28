const MTN_ERROR_MAP: Record<string, string> = {
  "4005": "Insufficient Balance",
  "4001": "Invalid Request",
  "4002": "Invalid Phone Number",
  "4003": "Transaction Not Allowed",
  "4004": "Daily Limit Exceeded",
  "4006": "Duplicate Transaction",
  "4007": "Transaction Timed Out",
  "4008": "Service Unavailable",
  "4009": "Invalid Amount",
  "4010": "Authentication Failed",
  "4011": "Account Suspended",
  "4012": "PIN Required",
  "4013": "Invalid PIN",
  "4014": "PIN Attempts Exceeded",
  "4015": "Recipient Not Registered",
  "4016": "Merchant Not Found",
  "4017": "Invalid Reference",
  "4018": "System Busy - Retry Later",
  "5001": "Internal Server Error",
  "5002": "Provider Network Error",
  "5003": "Database Error",
  "5004": "Timeout Error",
  "5005": "Unknown Error",
  "TECHNICAL_ERROR": "Technical Error - Please Try Again",
  "PAYER_NOT_FOUND": "Payer Account Not Found",
  "PAYEE_NOT_FOUND": "Recipient Account Not Found",
  "NOT_ALLOWED": "Transaction Type Not Allowed",
  "NOT_ENOUGH_FUNDS": "Insufficient Funds",
  "LIMIT_EXCEEDED": "Transaction Limit Exceeded",
  "DUPLICATE_REFERENCE": "Duplicate Transaction Reference",
  "INVALID_CALLBACK_URL": "Invalid Callback URL Configuration",
  "SUBSCRIPTION_KEY_INVALID": "Invalid API Subscription Key",
  "TOKEN_EXPIRED": "Session Expired - Please Retry",
};

const AIRTEL_ERROR_MAP: Record<string, string> = {
  "DP_REQUEST_FAILED": "Payment Request Failed - Please Retry",
  "DP_PENDING": "Transaction Pending - Awaiting Confirmation",
  "DP_SUCCESS": "Transaction Successful",
  "DP_INVALID_MSISDN": "Invalid Phone Number",
  "DP_INVALID_AMOUNT": "Invalid Transaction Amount",
  "DP_INVALID_REFERENCE": "Invalid Transaction Reference",
  "DP_INSUFFICIENT_BALANCE": "Insufficient Balance",
  "DP_SERVICE_UNAVAILABLE": "Service Temporarily Unavailable",
  "DP_LIMIT_EXCEEDED": "Daily Transaction Limit Exceeded",
  "DP_DUPLICATE_REFERENCE": "Duplicate Transaction Reference",
  "DP_AUTH_FAILED": "Authentication Failed",
  "DP_TIMEOUT": "Transaction Timed Out",
  "DP_SYSTEM_ERROR": "System Error - Please Retry",
  "BALANCE_OK": "Balance Check Successful",
  "BALANCE_UNAVAILABLE": "Balance Information Unavailable",
  "DS_SUCCESS": "Disbursement Successful",
  "DS_REQUEST_FAILED": "Disbursement Failed - Please Retry",
  "DS_PENDING": "Disbursement Pending",
};

const UNMAPPED_ERRORS: unknown[] = [];

export type ProviderType = "mtn" | "airtel" | "orange" | "vodacom" | "tigo";

export function mapProviderError(
  errorCode: string | number | undefined | null,
  provider?: ProviderType,
): string {
  if (errorCode === undefined || errorCode === null) {
    return "Unknown Error";
  }

  const code = String(errorCode).trim();

  if (provider === "mtn" || !provider) {
    const mapped = MTN_ERROR_MAP[code];
    if (mapped) return mapped;
  }

  if (provider === "airtel") {
    const mapped = AIRTEL_ERROR_MAP[code];
    if (mapped) return mapped;
  }

  UNMAPPED_ERRORS.push({ code, provider, timestamp: new Date().toISOString() });
  if (UNMAPPED_ERRORS.length > 1000) {
    UNMAPPED_ERRORS.splice(0, UNMAPPED_ERRORS.length - 1000);
  }

  return `Error: ${code}`;
}

export function getUnmappedErrors(): unknown[] {
  return [...UNMAPPED_ERRORS];
}

export function clearUnmappedErrors(): void {
  UNMAPPED_ERRORS.length = 0;
}

export function getErrorMessage(
  error: unknown,
  provider?: ProviderType,
): string {
  if (!error) return "Unknown Error";
  if (typeof error === "string") {
    if (/^\d{4}$/.test(error) || /^[A-Z_]/.test(error)) {
      return mapProviderError(error, provider);
    }
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    const code = err.code ?? err.errorCode ?? err.status ?? err.message;
    if (code) {
      return mapProviderError(String(code), provider);
    }
  }
  return "Unknown Error";
}
