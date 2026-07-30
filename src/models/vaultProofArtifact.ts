import { queryRead, queryWrite } from "../config/database";

export type VaultProofArtifactStatus =
  | "issued"
  | "verified"
  | "review"
  | "rejected";

export interface VaultProofArtifact {
  id: string;
  vaultId: string;
  userId: string;
  applicantId: string;
  proofType: string;
  proofVersion: string;
  status: VaultProofArtifactStatus;
  commitment: string;
  signature: string;
  signatureContext: Record<string, any>;
  proofPayload: Record<string, any>;
  complianceScore: number | null;
  complianceChecks: Array<Record<string, any>>;
  artifactCiphertext: string;
  artifactHash: string;
  providerReference?: string | null;
  documentHash: string;
  documentFilename?: string | null;
  documentMimeType?: string | null;
  issuedAt: Date;
  verifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVaultProofArtifactInput {
  vaultId: string;
  userId: string;
  applicantId: string;
  proofType: string;
  proofVersion: string;
  status: VaultProofArtifactStatus;
  commitment: string;
  signature: string;
  signatureContext: Record<string, any>;
  proofPayload: Record<string, any>;
  complianceScore: number;
  complianceChecks: Array<Record<string, any>>;
  artifactCiphertext: string;
  artifactHash: string;
  providerReference?: string;
  documentHash: string;
  documentFilename?: string;
  documentMimeType?: string;
  issuedAt: string;
}

export interface UpdateVaultProofVerificationInput {
  status: VaultProofArtifactStatus;
  complianceScore: number;
  complianceChecks: Array<Record<string, any>>;
  proofPayload?: Record<string, any>;
  verifiedAt?: string;
}

const SELECT_COLUMNS = `
  id,
  vault_id AS "vaultId",
  user_id AS "userId",
  applicant_id AS "applicantId",
  proof_type AS "proofType",
  proof_version AS "proofVersion",
  status,
  commitment,
  signature,
  signature_context AS "signatureContext",
  proof_payload AS "proofPayload",
  compliance_score AS "complianceScore",
  compliance_checks AS "complianceChecks",
  artifact_ciphertext AS "artifactCiphertext",
  artifact_hash AS "artifactHash",
  provider_reference AS "providerReference",
  document_hash AS "documentHash",
  document_filename AS "documentFilename",
  document_mime_type AS "documentMimeType",
  issued_at AS "issuedAt",
  verified_at AS "verifiedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export class VaultProofArtifactModel {
  async create(
    input: CreateVaultProofArtifactInput,
  ): Promise<VaultProofArtifact> {
    const result = await queryWrite(
      `INSERT INTO vault_proof_artifacts (
        vault_id,
        user_id,
        applicant_id,
        proof_type,
        proof_version,
        status,
        commitment,
        signature,
        signature_context,
        proof_payload,
        compliance_score,
        compliance_checks,
        artifact_ciphertext,
        artifact_hash,
        provider_reference,
        document_hash,
        document_filename,
        document_mime_type,
        issued_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19
      )
      RETURNING ${SELECT_COLUMNS}`,
      [
        input.vaultId,
        input.userId,
        input.applicantId,
        input.proofType,
        input.proofVersion,
        input.status,
        input.commitment,
        input.signature,
        JSON.stringify(input.signatureContext),
        JSON.stringify(input.proofPayload),
        input.complianceScore,
        JSON.stringify(input.complianceChecks),
        input.artifactCiphertext,
        input.artifactHash,
        input.providerReference || null,
        input.documentHash,
        input.documentFilename || null,
        input.documentMimeType || null,
        input.issuedAt,
      ],
    );

    return result.rows[0];
  }

  async findById(
    id: string,
    userId?: string,
  ): Promise<VaultProofArtifact | null> {
    const clauses = ["id = $1"];
    const params: any[] = [id];

    if (userId) {
      clauses.push(`user_id = $${params.length + 1}`);
      params.push(userId);
    }

    const result = await queryRead(
      `SELECT ${SELECT_COLUMNS}
       FROM vault_proof_artifacts
       WHERE ${clauses.join(" AND ")}
       LIMIT 1`,
      params,
    );

    return result.rows[0] || null;
  }

  async findLatestByApplicant(
    applicantId: string,
    userId?: string,
  ): Promise<VaultProofArtifact | null> {
    const clauses = ["applicant_id = $1"];
    const params: any[] = [applicantId];

    if (userId) {
      clauses.push(`user_id = $${params.length + 1}`);
      params.push(userId);
    }

    const result = await queryRead(
      `SELECT ${SELECT_COLUMNS}
       FROM vault_proof_artifacts
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT 1`,
      params,
    );

    return result.rows[0] || null;
  }

  async updateVerification(
    id: string,
    userId: string,
    input: UpdateVaultProofVerificationInput,
  ): Promise<VaultProofArtifact | null> {
    const result = await queryWrite(
      `UPDATE vault_proof_artifacts
       SET status = $1,
           compliance_score = $2,
           compliance_checks = $3::jsonb,
           proof_payload = COALESCE(proof_payload, '{}'::jsonb) || $4::jsonb,
           verified_at = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND user_id = $7
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.status,
        input.complianceScore,
        JSON.stringify(input.complianceChecks),
        JSON.stringify(input.proofPayload || {}),
        input.verifiedAt || null,
        id,
        userId,
      ],
    );

    return result.rows[0] || null;
  }
}

export default VaultProofArtifactModel;
