import { apiRequest, getStoredToken } from './apiClient';
import { googleDriveService } from './googleDriveService';
import type { DocumentCategory, DriveFile, FileKind, VaultDocument } from './types';

function inferFileType(name: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'png') return 'png';
  if (ext === 'txt') return 'txt';
  return 'other';
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function mimeFor(fileType: FileKind): string {
  const map: Record<FileKind, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    other: 'application/octet-stream',
  };
  return map[fileType] || 'application/octet-stream';
}

function mapDocument(raw: any): VaultDocument {
  const isDrive = raw.source === 'drive' || raw.source === 'google-drive';
  const fileType = inferFileType(raw.name);
  return {
    id: raw.id,
    name: raw.name,
    category: (raw.category as DocumentCategory) || 'Other',
    subcategory: raw.subcategory || `${raw.category || 'Other'} / General`,
    status: raw.status || 'completed',
    fileType: raw.fileType || fileType,
    mimeType: raw.mimeType || mimeFor(fileType),
    sizeBytes: raw.sizeBytes || 0,
    sizeLabel: raw.sizeLabel || '0 KB',
    uploadedAt: raw.createdAt ? new Date(raw.createdAt).toLocaleDateString() : 'Recently',
    modifiedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    source: isDrive ? 'google-drive' : 'device',
    drivePath: isDrive ? `/FormFlow Vault/${raw.category || 'Documents'}/${raw.name}` : `/Local uploads/${raw.name}`,
    driveFileId: raw.sourceFileId || undefined,
    confidence: 95,
    extractedCount: raw.extractedCount || 0,
    processingError: raw.processingError || undefined,
    failureReason: raw.processingError || undefined,
    extractedText: raw.extractedText || undefined,
  };
}

export const documentService = {
  isDemo: false,

  async list(): Promise<VaultDocument[]> {
    try {
      const data = await apiRequest<{ documents: any[] }>('/api/documents');
      if (!Array.isArray(data?.documents)) return [];
      return data.documents.map(mapDocument);
    } catch {
      return [];
    }
  },

  async get(id: string): Promise<VaultDocument | undefined> {
    const list = await this.list();
    return list.find((doc) => doc.id === id);
  },

  async addFromDrive(files: DriveFile[]): Promise<VaultDocument[]> {
    const created: VaultDocument[] = [];
    for (const file of files) {
      try {
        const result = await googleDriveService.importFile(file.id, file.name, file.category, file.subcategory);
        if (result?.document) {
          created.push(mapDocument(result.document));
        }
      } catch (err) {
        console.error('Failed to import drive file:', file.name, err);
      }
    }
    return created;
  },

  async uploadLocal(files: File[]): Promise<{ accepted: VaultDocument[]; rejected: string[] }> {
    const allowed = ['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png', 'txt'];
    const accepted: VaultDocument[] = [];
    const rejected: string[] = [];
    const validFiles: File[] = [];

    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!allowed.includes(ext) || file.size > 20 * 1024 * 1024) {
        rejected.push(file.name);
      } else {
        validFiles.push(file);
      }
    }

    if (validFiles.length > 0) {
      const formData = new FormData();
      for (const file of validFiles) {
        formData.append('files', file, file.name);
      }

      const token = getStoredToken();
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;

      try {
        const response = await fetch('/api/documents/upload', {
          method: 'POST',
          headers,
          body: formData,
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Upload failed with status ${response.status}`);
        }

        const data = await response.json();
        if (Array.isArray(data.documents)) {
          for (const doc of data.documents) {
            accepted.push(mapDocument(doc));
          }
        }
      } catch (err) {
        console.error('Failed to upload files to backend:', err);
        for (const file of validFiles) {
          rejected.push(file.name);
        }
      }
    }

    return { accepted, rejected };
  },

  getPreviewUrl(id: string): string {
    return `/api/documents/${id}/preview`;
  },

  async finishProcessing(id: string): Promise<VaultDocument | undefined> {
    return this.get(id);
  },

  async retry(id: string): Promise<VaultDocument | undefined> {
    try {
      const data = await apiRequest<{ document: any }>(`/api/documents/${id}/reprocess`, {
        method: 'POST',
        body: '{}',
      });
      return data?.document ? mapDocument(data.document) : undefined;
    } catch (err) {
      console.error('Failed to reprocess document:', err);
      return undefined;
    }
  },

  async remove(id: string): Promise<void> {
    await apiRequest(`/api/documents/${id}`, { method: 'DELETE' });
  },

  async rename(id: string, name: string): Promise<VaultDocument | undefined> {
    const data = await apiRequest<{ document: any }>(`/api/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    return mapDocument(data.document);
  },

  async unlink(id: string): Promise<VaultDocument | undefined> {
    return this.get(id);
  },

  async markNeedsAttention(id: string): Promise<void> {
    // No-op
  },

  async availableDriveFiles(): Promise<DriveFile[]> {
    return googleDriveService.listFiles();
  },
};
