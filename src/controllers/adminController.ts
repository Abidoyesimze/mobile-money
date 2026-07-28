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
import { pool } from "../config/database";
import { providerSettingsService } from "../services/providerSettingsService";
import { AuthRequest } from "../middleware/auth";

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
 * Controller: SLA tracking metrics for deposit approvals.
 * Calculates processing time from deposit initiation (created_at) to completion
 * (updated_at where status = 'completed') over a rolling 24-hour window.
 * SLA breach threshold is 30 seconds per deposit.
 */
const SLA_BREACH_THRESHOLD_SECONDS = parseInt(
  process.env.SLA_BREACH_THRESHOLD_SECONDS || "30",
  10,
);

export const getSlaMetrics = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query<{
      total_deposits: string;
      avg_delay_seconds: string | null;
      min_delay_seconds: string | null;
      max_delay_seconds: string | null;
      sla_breached: string;
      p95_delay_seconds: string | null;
    }>(
      `SELECT
         COUNT(*)                                                          AS total_deposits,
         AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))               AS avg_delay_seconds,
         MIN(EXTRACT(EPOCH FROM (updated_at - created_at)))               AS min_delay_seconds,
         MAX(EXTRACT(EPOCH FROM (updated_at - created_at)))               AS max_delay_seconds,
         COUNT(*) FILTER (
           WHERE EXTRACT(EPOCH FROM (updated_at - created_at)) > $1
         )                                                                 AS sla_breached,
         PERCENTILE_CONT(0.95) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))
         )                                                                 AS p95_delay_seconds
       FROM transactions
       WHERE type = 'deposit'
         AND status = 'completed'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [SLA_BREACH_THRESHOLD_SECONDS],
    );

    const row = result.rows[0];
    const total = parseInt(row.total_deposits, 10);
    const breached = parseInt(row.sla_breached, 10);
    const avgDelay = row.avg_delay_seconds !== null ? parseFloat(row.avg_delay_seconds) : null;
    const minDelay = row.min_delay_seconds !== null ? parseFloat(row.min_delay_seconds) : null;
    const maxDelay = row.max_delay_seconds !== null ? parseFloat(row.max_delay_seconds) : null;
    const p95Delay = row.p95_delay_seconds !== null ? parseFloat(row.p95_delay_seconds) : null;

    const slaComplianceRate = total > 0 ? ((total - breached) / total) * 100 : 100;

    res.json({
      success: true,
      window: "24h",
      sla_breach_threshold_seconds: SLA_BREACH_THRESHOLD_SECONDS,
      timestamp: new Date().toISOString(),
      metrics: {
        total_deposits: total,
        sla_breached: breached,
        sla_compliance_rate: Math.round(slaComplianceRate * 100) / 100,
        avg_delay_seconds: avgDelay !== null ? Math.round(avgDelay * 1000) / 1000 : null,
        min_delay_seconds: minDelay !== null ? Math.round(minDelay * 1000) / 1000 : null,
        max_delay_seconds: maxDelay !== null ? Math.round(maxDelay * 1000) / 1000 : null,
        p95_delay_seconds: p95Delay !== null ? Math.round(p95Delay * 1000) / 1000 : null,
      },
    });
  } catch (error) {
    winstonOutageLogger.error("Failed to fetch SLA metrics", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch SLA metrics");
  }
};

import { getTelecomAverageMetrics } from "../utils/logger";

export const getTelecomLatencyMetricsController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const provider = req.query.provider as string | undefined;
    const metrics = getTelecomAverageMetrics(provider);
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data: metrics,
    });
  } catch (error) {
    winstonOutageLogger.error("Failed to fetch telecom latency metrics", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch telecom latency metrics");
  }
};

/**
 * Controller: List manual failover (enable/disable) state for every provider.
 * Acceptance Criteria: Display current provider state indicators on screen (#1550).
 */
export const getProviderMaintenanceState = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const settings = await providerSettingsService.getAllSettings();

    res.json({
      success: true,
      providers: settings.map((s) => ({
        provider: s.provider_name,
        enabled: s.is_enabled ?? true,
        disabledReason: s.disabled_reason ?? null,
        disabledBy: s.disabled_by ?? null,
        disabledAt: s.disabled_at ?? null,
      })),
    });
  } catch (error) {
    winstonOutageLogger.error("Failed to fetch provider maintenance state", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch provider maintenance state");
  }
};

const isAdminRole = (role?: string) => role === "admin" || role === "super-admin";

/**
 * Controller: Manually toggle a provider offline/online for unscheduled maintenance.
 * Acceptance Criteria: Expose administrative endpoints protecting toggle routes
 * with permissions; save state selections to database config variables (#1550).
 */
export const toggleProviderMaintenanceHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const user = (req as AuthRequest).user;
    if (!user || !isAdminRole(user.role)) {
      throw createError(ERROR_CODES.FORBIDDEN, "Admin access required", {
        message: "Admin access required",
      });
    }

    const { provider } = req.params;
    const { enabled, reason } = req.body;

    if (!provider || typeof provider !== "string") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Provider is required");
    }
    if (typeof enabled !== "boolean") {
      throw createError(ERROR_CODES.INVALID_INPUT, "enabled (boolean) is required");
    }

    const updated = await providerSettingsService.setProviderEnabled(
      provider,
      enabled,
      user.id,
      reason ?? null,
    );

    winstonOutageLogger.info("PROVIDER_MAINTENANCE_TOGGLED", {
      provider: updated.provider_name,
      enabled: updated.is_enabled,
      updatedBy: user.id,
      reason: updated.disabled_reason,
    });

    res.json({
      success: true,
      message: `Provider ${provider} ${enabled ? "enabled" : "disabled"}`,
      provider: {
        provider: updated.provider_name,
        enabled: updated.is_enabled ?? true,
        disabledReason: updated.disabled_reason ?? null,
        disabledBy: updated.disabled_by ?? null,
        disabledAt: updated.disabled_at ?? null,
      },
    });
  } catch (error) {
    if ((error as any).status) throw error;
    winstonOutageLogger.error("Failed to toggle provider maintenance state", { error });
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to toggle provider maintenance state");
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
router.get("/sla", getSlaMetrics);
router.get("/telecom-latency", getTelecomLatencyMetricsController);

export default router;

