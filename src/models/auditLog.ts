import { pool } from "../config/database";

export interface AuditLog {
  id: string;
  adminId: string;
  action: string;
  resource: string;
  resourceId: string | null;
  diff: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface CreateAuditLogInput {
  adminId: string;
  action: string;
  resource: string;
  resourceId?: string | null;
  diff: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditLogFilter {
  adminId?: string;
  resource?: string;
  resourceId?: string;
  limit?: number;
  offset?: number;
}

const selectFields = `
  id,
  admin_id AS "adminId",
  action,
  resource,
  resource_id AS "resourceId",
  diff,
  ip_address AS "ipAddress",
  user_agent AS "userAgent",
  created_at AS "createdAt"
`;

export class AuditLogModel {
  async create(input: CreateAuditLogInput): Promise<AuditLog> {
    const result = await pool.query<AuditLog>(
      `
        INSERT INTO audit_logs (
          admin_id,
          action,
          resource,
          resource_id,
          diff,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING ${selectFields}
      `,
      [
        input.adminId,
        input.action,
        input.resource,
        input.resourceId ?? null,
        JSON.stringify(input.diff),
        input.ipAddress ?? null,
        input.userAgent ?? null,
      ],
    );

    return result.rows[0];
  }

  async findById(id: string): Promise<AuditLog | null> {
    const result = await pool.query<AuditLog>(
      `
        SELECT ${selectFields}
        FROM audit_logs
        WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ?? null;
  }

  async list(filter: AuditLogFilter = {}): Promise<AuditLog[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.adminId) {
      params.push(filter.adminId);
      conditions.push(`admin_id = $${params.length}`);
    }

    if (filter.resource) {
      params.push(filter.resource);
      conditions.push(`resource = $${params.length}`);
    }

    if (filter.resourceId) {
      params.push(filter.resourceId);
      conditions.push(`resource_id = $${params.length}`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(filter.limit ?? 100);
    const limitParameter = params.length;
    params.push(filter.offset ?? 0);
    const offsetParameter = params.length;

    const result = await pool.query<AuditLog>(
      `
        SELECT ${selectFields}
        FROM audit_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${limitParameter} OFFSET $${offsetParameter}
      `,
      params,
    );

    return result.rows;
  }
}
