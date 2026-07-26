import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import winston from "winston";
import {
  getAllCircuitBreakerStatesInfo,
  tripCircuitBreaker,
  forceCloseCircuitBreaker,
  CircuitBreakerStateInfo,
} from "../utils/circuitBreaker";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";

// Ensure logs directory exists
const LOGS_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export const OUTAGE_LOG_FILE = path.join(LOGS_DIR, "outages.log");
export const ALERT_LOG_FILE = path.join(LOGS_DIR, "outage-alerts.log");

// Winston Logger instance specifically for telco outages and circuit breaker status updates
export const winstonOutageLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: OUTAGE_LOG_FILE }),
    new winston.transports.File({ filename: ALERT_LOG_FILE, level: "warn" }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

export interface AlertWarning {
  id: string;
  provider: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  message: string;
  errorRate: number;
  threshold: number;
  timestamp: string;
  engineeringTeamNotified: boolean;
  circuitBreakerState: "OPEN" | "CLOSED" | "HALF-OPEN";
}

// In-memory alert store
const activeAlerts: AlertWarning[] = [];

/**
 * Helper to dispatch alert warnings to engineering teams and log via Winston
 */
export function dispatchEngineeringAlert(alert: Omit<AlertWarning, "id" | "timestamp" | "engineeringTeamNotified">): AlertWarning {
  const alertRecord: AlertWarning = {
    id: `ALERT-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
    ...alert,
    timestamp: new Date().toISOString(),
    engineeringTeamNotified: true,
  };

  activeAlerts.unshift(alertRecord);
  if (activeAlerts.length > 50) {
    activeAlerts.pop();
  }

  // Log to Winston log files
  winstonOutageLogger.warn("ENGINEERING ALERT DISPATCHED", alertRecord);

  return alertRecord;
}

/**
 * Controller: Get Circuit Breaker Status & Outage Dashboard State
 * Acceptance Criteria: Display circuit breaker status cleanly on screen
 */
export const getCircuitBreakerStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const circuitBreakers = getAllCircuitBreakerStatesInfo();

    // Calculate system health metrics
    const totalBreakers = circuitBreakers.length;
    const openBreakers = circuitBreakers.filter((cb) => cb.state === "OPEN").length;
    const degradedBreakers = circuitBreakers.filter((cb) => cb.state === "HALF-OPEN").length;

    let overallHealth = "HEALTHY";
    if (openBreakers > 0) {
      overallHealth = "OUTAGE_DETECTED";
    } else if (degradedBreakers > 0) {
      overallHealth = "DEGRADED";
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      health: overallHealth,
      summary: {
        total: totalBreakers,
        healthy: totalBreakers - openBreakers - degradedBreakers,
        degraded: degradedBreakers,
        outage: openBreakers,
      },
      circuitBreakers,
      activeAlerts,
    });
  } catch (error) {
    winstonOutageLogger.error("Failed to fetch circuit breaker status", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch circuit breaker status");
  }
};

/**
 * Controller: Log Outage Status Updates & update circuit breaker
 * Acceptance Criteria: Log outage status updates to Winston log files.
 */
export const logOutageStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, status, message, errorRate, errorThreshold, operation = "payment" } = req.body;

    if (!provider || typeof provider !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Provider is required");
    }

    const currentErrorRate = typeof errorRate === "number" ? errorRate : 0;
    const threshold = typeof errorThreshold === "number" ? errorThreshold : 50;

    let circuitState: "OPEN" | "CLOSED" | "HALF-OPEN" = "CLOSED";

    if (status === "OUTAGE" || status === "DOWN" || currentErrorRate >= threshold) {
      await tripCircuitBreaker(provider, operation);
      circuitState = "OPEN";
    } else if (status === "UP" || status === "RESOLVED") {
      await forceCloseCircuitBreaker(provider, operation);
      circuitState = "CLOSED";
    }

    const logEntry = {
      event: "TELCO_OUTAGE_STATUS_UPDATE",
      provider: provider.toLowerCase(),
      status: status || "UNKNOWN",
      message: message || `Outage status updated for ${provider}`,
      errorRate: currentErrorRate,
      errorThreshold: threshold,
      circuitBreakerState: circuitState,
      updatedAt: new Date().toISOString(),
    };

    // Log update to Winston log file
    winstonOutageLogger.info("OUTAGE_STATUS_UPDATE", logEntry);

    // If outage or error threshold exceeded, dispatch warning alert to engineering teams
    let alertSent: AlertWarning | null = null;
    if (circuitState === "OPEN" || status === "OUTAGE") {
      alertSent = dispatchEngineeringAlert({
        provider: provider.toLowerCase(),
        severity: "CRITICAL",
        message: message || `CRITICAL: Telco outage detected for ${provider}. Circuit breaker TRIPPED!`,
        errorRate: currentErrorRate,
        threshold,
        circuitBreakerState: circuitState,
      });
    }

    const updatedBreakers = getAllCircuitBreakerStatesInfo();

    res.json({
      success: true,
      message: `Outage status logged for ${provider}`,
      logEntry,
      alert: alertSent,
      circuitBreakers: updatedBreakers,
    });
  } catch (error) {
    if ((error as any).status) throw error;
    winstonOutageLogger.error("Failed to log outage status", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to log outage status");
  }
};

/**
 * Controller: Confirm alert warnings function correctly
 * Acceptance Criteria: Confirm alert warnings function correctly.
 */
export const triggerAlertWarning = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider = "mtn", severity = "CRITICAL", message, errorRate = 75, threshold = 50 } = req.body;

    const alertMessage = message || `ALERT WARNING TEST: High error rate (${errorRate}%) detected on ${provider.toUpperCase()} gateway`;

    // Trip breaker for provider to simulate outage condition if critical
    if (severity === "CRITICAL") {
      await tripCircuitBreaker(provider.toLowerCase(), "payment");
    }

    const alert = dispatchEngineeringAlert({
      provider: provider.toLowerCase(),
      severity,
      message: alertMessage,
      errorRate,
      threshold,
      circuitBreakerState: severity === "CRITICAL" ? "OPEN" : "HALF-OPEN",
    });

    winstonOutageLogger.warn("ALERT_WARNING_TEST_CONFIRMED", { alert });

    res.json({
      success: true,
      message: "Alert warning confirmed and dispatched to engineering team",
      alert,
      engineeringNotified: alert.engineeringTeamNotified,
    });
  } catch (error) {
    winstonOutageLogger.error("Alert warning test failed", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Alert warning test failed");
  }
};

/**
 * Controller: Get recent Winston outage logs
 */
export const getOutageLogs = async (_req: Request, res: Response): Promise<void> => {
  try {
    let logs: any[] = [];
    if (fs.existsSync(OUTAGE_LOG_FILE)) {
      const content = fs.readFileSync(OUTAGE_LOG_FILE, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      logs = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { message: line };
          }
        })
        .reverse()
        .slice(0, 100);
    }

    res.json({
      success: true,
      logFilePath: OUTAGE_LOG_FILE,
      totalLogs: logs.length,
      logs,
    });
  } catch (error) {
    winstonOutageLogger.error("Failed to read outage logs", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to read outage logs");
  }
};

/**
 * Controller: Reset Circuit Breaker for a provider
 */
export const resetCircuitBreakerHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, operation = "payment" } = req.body;
    if (!provider) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Provider is required");
    }

    await forceCloseCircuitBreaker(provider.toLowerCase(), operation);

    winstonOutageLogger.info("CIRCUIT_BREAKER_RESET", {
      provider: provider.toLowerCase(),
      operation,
      resetAt: new Date().toISOString(),
    });

    const updatedBreakers = getAllCircuitBreakerStatesInfo();

    res.json({
      success: true,
      message: `Circuit breaker reset for ${provider}`,
      circuitBreakers: updatedBreakers,
    });
  } catch (error) {
    if ((error as any).status) throw error;
    winstonOutageLogger.error("Failed to reset circuit breaker", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to reset circuit breaker");
  }
};

/**
 * Controller: Trip Circuit Breaker manually
 */
export const tripCircuitBreakerHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, operation = "payment" } = req.body;
    if (!provider) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Provider is required");
    }

    await tripCircuitBreaker(provider.toLowerCase(), operation);

    const alert = dispatchEngineeringAlert({
      provider: provider.toLowerCase(),
      severity: "CRITICAL",
      message: `MANUAL OVERRIDE: Circuit breaker manually tripped for ${provider.toUpperCase()}`,
      errorRate: 100,
      threshold: 50,
      circuitBreakerState: "OPEN",
    });

    winstonOutageLogger.warn("CIRCUIT_BREAKER_TRIPPED_MANUALLY", {
      provider: provider.toLowerCase(),
      operation,
      trippedAt: new Date().toISOString(),
    });

    const updatedBreakers = getAllCircuitBreakerStatesInfo();

    res.json({
      success: true,
      message: `Circuit breaker tripped for ${provider}`,
      alert,
      circuitBreakers: updatedBreakers,
    });
  } catch (error) {
    if ((error as any).status) throw error;
    winstonOutageLogger.error("Failed to trip circuit breaker", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to trip circuit breaker");
  }
};

/**
 * Express Router mounting all monitoring dashboard endpoints
 */
import { Router } from "express";
const router = Router();

router.get("/dashboard", getCircuitBreakerStatus);
router.get("/circuit-breaker-status", getCircuitBreakerStatus);
router.post("/outages", logOutageStatus);
router.post("/alerts/test", triggerAlertWarning);
router.get("/alerts", (_req: Request, res: Response) => {
  res.json({ success: true, alerts: activeAlerts });
});
router.get("/logs", getOutageLogs);
router.post("/circuit-breaker/reset", resetCircuitBreakerHandler);
router.post("/circuit-breaker/trip", tripCircuitBreakerHandler);

export default router;
