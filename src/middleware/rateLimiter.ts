import rateLimit from "express-rate-limit";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export const TWO_FA_RATE_LIMITS = {
  verifyDevice: {
    windowMs: FIFTEEN_MINUTES_MS,
    limit: 5,
    message:
      "Too many verification attempts from this IP, please try again after 15 minutes",
  },
  resendVerification: {
    windowMs: FIFTEEN_MINUTES_MS,
    limit: 3,
    message:
      "Too many resend requests from this IP, please try again after 15 minutes",
  },
};

const skipRateLimitInTests = () =>
  process.env.NODE_ENV === "test" &&
  process.env.ENABLE_AUTH_RATE_LIMIT_TESTS !== "true";

export const verifyDeviceRateLimiter = rateLimit({
  windowMs: TWO_FA_RATE_LIMITS.verifyDevice.windowMs,
  limit: TWO_FA_RATE_LIMITS.verifyDevice.limit,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimitInTests,
  message: {
    error: "Too Many Requests",
    message: TWO_FA_RATE_LIMITS.verifyDevice.message,
  },
});

export const resendVerificationRateLimiter = rateLimit({
  windowMs: TWO_FA_RATE_LIMITS.resendVerification.windowMs,
  limit: TWO_FA_RATE_LIMITS.resendVerification.limit,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimitInTests,
  message: {
    error: "Too Many Requests",
    message: TWO_FA_RATE_LIMITS.resendVerification.message,
  },
});
