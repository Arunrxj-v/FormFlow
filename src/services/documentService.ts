import { documentService as coreDocumentService } from '../../core/application/document-service';
import type { DocumentCategory, VaultDocument } from '../../shared/types';

export const documentService = {
  isLocal: true,

  list(): Promise<VaultDocument[]> {
    return coreDocumentService.list();
  },

  get(id: string): Promise<VaultDocument | null> {
    return coreDocumentService.get(id);
  },

  importDocument(file: File, category?: DocumentCategory, subcategory?: string) {
    return coreDocumentService.importDocument({ file, category, subcategory });
  },

  async openInBrowser(id: string): Promise<void> {
    const blob = await coreDocumentService.getBlob(id);
    if (!blob) throw new Error('Original document file is not available locally.');
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },

  async download(id: string, fileName: string): Promise<void> {
    const blob = await coreDocumentService.getBlob(id);
    if (!blob) throw new Error('Original document file is not available locally.');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },

  async rename(id: string, name: string): Promise<VaultDocument> {
    return coreDocumentService.rename(id, name);
  },

  async remove(id: string): Promise<void> {
    await coreDocumentService.remove(id);
  },

  async getStorageEstimate() {
    return coreDocumentService.getStorageEstimate();
  },
};
