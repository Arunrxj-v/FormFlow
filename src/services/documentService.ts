import { vaultClient } from '@/services/vaultClient';
import type { DocumentCategory, VaultDocument } from '../../shared/types';

const objectUrls = new Set<string>();

function trackObjectUrl(url: string): void {
  objectUrls.add(url);
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }, 60_000);
}

export function revokeDocumentObjectUrls(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

export const documentService = {
  isLocal: true,

  list(): Promise<VaultDocument[]> {
    return vaultClient.listDocuments();
  },

  get(id: string): Promise<VaultDocument | null> {
    return vaultClient.getDocument(id);
  },

  importDocument(file: File, category?: DocumentCategory, subcategory?: string) {
    return vaultClient.importDocument(file, category, subcategory);
  },

  async openInBrowser(id: string): Promise<void> {
    const result = await vaultClient.getDocumentBlob(id);
    if (!result) throw new Error('Original document file is not available locally.');
    const url = URL.createObjectURL(result.blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    trackObjectUrl(url);
  },

  async download(id: string, fileName: string): Promise<void> {
    const result = await vaultClient.getDocumentBlob(id);
    if (!result) throw new Error('Original document file is not available locally.');
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    trackObjectUrl(url);
  },

  async rename(id: string, name: string): Promise<VaultDocument> {
    return vaultClient.renameDocument(id, name);
  },

  async remove(id: string): Promise<void> {
    await vaultClient.deleteDocument(id);
  },

  async getStorageEstimate() {
    return vaultClient.storageEstimate();
  },
};
