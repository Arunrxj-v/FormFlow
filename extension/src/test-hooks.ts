import { downgradeVaultToV1 } from '../../core/vault/downgrade-test';
import { encryptionV2Migration, type EncryptionMigrationFaultPoint } from '../../core/vault/encryption-v2-migration';
import { documentRepository } from '../../core/database/repositories';
import { vaultRepository as vaultRecordRepository } from '../../core/database/vault-repository';
import { sha256Hex } from '../../core/encryption/crypto-service';

declare global {
  var __formflowTestHooks:
    | {
      downgradeVaultToV1: typeof downgradeVaultToV1;
      runMigration: () => Promise<unknown>;
      seedDocuments: (count: number, sizeBytes: number) => Promise<number>;
    }
    | undefined;
  var __formflowMigrationRelease: (() => void) | undefined;
}

export function installTestHooks(): void {
  globalThis.__formflowTestHooks = {
    downgradeVaultToV1,
    seedDocuments: async (count, sizeBytes) => {
      const vault = await vaultRecordRepository.getActive();
      if (!vault) throw new Error('No active vault for test fixture.');
      const safeSize = Math.max(64, Math.min(sizeBytes, 4096));
      for (let index = 0; index < count; index += 1) {
        const content = `migration-bulk-${index}-` + 'x'.repeat(safeSize);
        const checksum = await sha256Hex(content);
        const document = await documentRepository.create(
          {
            vaultId: vault.id,
            mimeType: 'application/pdf',
            extension: 'pdf',
            category: 'Other',
            subcategory: '',
            status: 'stored',
            fileType: 'pdf',
            sizeBytes: content.length,
            sizeLabel: `${content.length} B`,
            checksum,
            storageKey: '',
            source: 'device',
            ocrUsed: false,
            extractedTextStatus: 'pending',
            metadata: { fixture: true },
          },
          `bulk-migration-${index}.pdf`,
        );
        await documentRepository.saveOriginalFile(document.id, 'application/pdf', new Blob([content], { type: 'application/pdf' }));
        await documentRepository.update(document.id, { storageKey: `file_${document.id}` });
      }
      return count;
    },
    runMigration: () => encryptionV2Migration.runIfNeeded({
      fault: async (point: EncryptionMigrationFaultPoint, detail?: Record<string, unknown>) => {
        await chrome.storage.session.set({
          'formflow-test-migration-progress': {
            point,
            store: typeof detail?.store === 'string' ? detail.store : null,
            at: Date.now(),
          },
        });
        if (point === 'after_journal' && detail?.store === 'documents') {
          // Hold the migration after a confirmed committed batch until the
          // external harness SIGKILLs the browser process.
          await new Promise<void>((resolve) => {
            globalThis.__formflowMigrationRelease = resolve;
          });
        }
      },
    }),
  };
}
