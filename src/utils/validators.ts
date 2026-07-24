import { z } from "zod";

export interface ExpiryValidationOptions {
  /**
   * Optional reference date to compare against. Defaults to current date/time.
   */
  referenceDate?: Date;

  /**
   * Whether the expiry date field is required. Defaults to false.
   */
  required?: boolean;
}

export interface ExpiryValidationResult {
  isValid: boolean;
  isExpired?: boolean;
  error?: string;
  parsedDate?: Date;
}

/**
 * Parses an expiry date input into a valid Date object.
 * Returns null if input is invalid or cannot be parsed.
 */
export function parseExpiryDate(
  input: string | Date | number | null | undefined,
): Date | null {
  if (input === null || input === undefined || input === "") {
    return null;
  }

  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input;
  }

  if (typeof input === "number") {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }

  const str = String(input).trim();
  if (!str) return null;

  // Strict YYYY-MM-DD or YYYY/MM/DD validation to avoid JS date roll-over (e.g. 2025-02-31)
  const ymdMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T.*)?$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);

    if (month < 0 || month > 11 || day < 1 || day > 31) {
      return null;
    }

    if (str.includes("T")) {
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    }

    // Set to end of the day in UTC for calendar dates
    const date = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }

  const date = new Date(str);
  if (isNaN(date.getTime())) {
    return null;
  }

  return date;
}

/**
 * Returns true if the expiry date is past the reference date.
 */
export function isDocumentExpired(
  expiryDate: string | Date | number,
  referenceDate: Date = new Date(),
): boolean {
  const parsed = parseExpiryDate(expiryDate);
  if (!parsed) return true;
  return parsed.getTime() < referenceDate.getTime();
}

/**
 * Validates document expiry date inputs.
 */
export function validateExpiryDate(
  input: string | Date | number | null | undefined,
  options: ExpiryValidationOptions = {},
): ExpiryValidationResult {
  const { referenceDate = new Date(), required = false } = options;

  if (input === null || input === undefined || input === "") {
    if (required) {
      return {
        isValid: false,
        error: "Document expiry date is required",
      };
    }
    return { isValid: true };
  }

  const parsedDate = parseExpiryDate(input);
  if (!parsedDate) {
    return {
      isValid: false,
      error:
        "Invalid expiry date format. Please provide a valid date (e.g. YYYY-MM-DD)",
    };
  }

  if (parsedDate.getTime() < referenceDate.getTime()) {
    return {
      isValid: false,
      isExpired: true,
      error: "Document has expired. Expiry date cannot be in the past",
      parsedDate,
    };
  }

  return {
    isValid: true,
    isExpired: false,
    parsedDate,
  };
}

/**
 * Zod schema helper for optional or required expiry dates.
 */
export const expiryDateSchema = (required = false) =>
  z.string().optional().refine(
    (val) => {
      const result = validateExpiryDate(val, { required });
      return result.isValid;
    },
    (val) => {
      const result = validateExpiryDate(val, { required });
      return { message: result.error || "Invalid expiry date" };
    },
  );
