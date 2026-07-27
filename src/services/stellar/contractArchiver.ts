import { getStellarServer } from "../../config/stellar";
import { insertContractStateArchive } from "../../database/contractStateArchiveRepository";
import EventSource from "eventsource";

export interface ContractArchiverConfig {
  contractId?: string;
  streamUrl?: string;
}

export interface ContractStateArchivePayload {
  contractId: string;
  txHash: string;
  ledger: number;
  eventType: string;
  eventName?: string | null;
  eventDetails?: Record<string, any> | null;
  snapshotData?: Record<string, any> | null;
  createdAt?: Date;
}

export class ContractArchiverService {
  private readonly contractId: string;
  private readonly horizon: any;
  private readonly streamUrl: string;

  constructor(config: ContractArchiverConfig = {}) {
    this.horizon = getStellarServer();
    this.contractId = config.contractId || process.env.SOROBAN_CONTRACT_ID || "";
    const horizonUrl = (this.horizon as any).serverURL || (this.horizon as any).host;
    this.streamUrl =
      config.streamUrl ||
      `${horizonUrl}/accounts/${this.contractId}/transactions?cursor=now&limit=200&order=asc`;
  }

  start(): void {
    if (!this.contractId) {
      console.warn("SOROBAN_CONTRACT_ID not set – contract state archiver disabled");
      return;
    }

    const eventSource = new EventSource(this.streamUrl);

    eventSource.onmessage = async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (!data || !data._embedded?.records) return;

        for (const tx of data._embedded.records) {
          const operationsResponse = await this.horizon
            .operations()
            .forTransaction(tx.id)
            .call();

          for (const op of operationsResponse.records) {
            const operation = op as any;
            if (operation.type !== "contract_event") continue;
            if (operation.contract !== this.contractId) continue;

            const payload: ContractStateArchivePayload = {
              contractId: this.contractId,
              txHash: tx.hash,
              ledger: tx.ledger_seq,
              eventType: operation.type,
              eventName: operation.value?.type || operation.value?.name || null,
              eventDetails: operation.value?.payload || operation.value || null,
              snapshotData: {
                contract: this.contractId,
                txHash: tx.hash,
                ledger: tx.ledger_seq,
                value: operation.value || {},
              },
              createdAt: new Date(),
            };

            await insertContractStateArchive(payload);
          }
        }
      } catch (error) {
        console.error("Contract state archiver failed to process event", error);
      }
    };

    eventSource.onerror = (error) => {
      console.error("Contract state archiver stream error", error);
      setTimeout(() => this.start(), 5000);
    };
  }
}

export function initializeContractArchiver() {
  const service = new ContractArchiverService();
  service.start();
}
