import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_DIR = process.env.STORAGE_DIR || path.resolve(__dirname, 'storage', 'documents');

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const ALLOWED_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png', 'txt']);

const MIME_MAP = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return 'document';
  const base = path.basename(filename).trim();
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.slice(0, 150) || 'document';
}

export function computeSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function validateFileBuffer({ filename, buffer, mimeType }) {
  if (!buffer || !(buffer instanceof Buffer)) {
    throw new Error('Invalid file content received.');
  }

  if (buffer.length === 0) {
    throw new Error('Uploaded file is empty (0 bytes).');
  }

  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File exceeds maximum size limit of 20 MB (${(buffer.length / (1024 * 1024)).toFixed(1)} MB).`);
  }

  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type ".${ext}". FormFlow supports PDF, DOCX, TXT, JPG, and PNG.`);
  }

  // Magic byte verification where applicable
  if (ext === 'pdf') {
    const magic = buffer.subarray(0, 5).toString('ascii');
    if (!magic.startsWith('%PDF-')) {
      throw new Error('Invalid PDF format: missing %PDF- file signature.');
    }
  } else if (ext === 'docx') {
    const magic = buffer.subarray(0, 4);
    // DOCX is a ZIP container: 50 4B 03 04
    if (magic[0] !== 0x50 || magic[1] !== 0x4B || magic[2] !== 0x03 || magic[3] !== 0x04) {
      throw new Error('Invalid DOCX format: missing standard OpenXML document signature.');
    }
  } else if (ext === 'png') {
    const magic = buffer.subarray(0, 8);
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (magic[0] !== 0x89 || magic[1] !== 0x50 || magic[2] !== 0x4E || magic[3] !== 0x47) {
      throw new Error('Invalid PNG format: missing PNG file signature.');
    }
  } else if (ext === 'jpg' || ext === 'jpeg') {
    const magic = buffer.subarray(0, 3);
    // JPEG: FF D8 FF
    if (magic[0] !== 0xFF || magic[1] !== 0xD8 || magic[2] !== 0xFF) {
      throw new Error('Invalid JPEG format: missing JPEG file signature.');
    }
  } else if (ext === 'txt') {
    // Check for excessive binary null bytes
    let nullCount = 0;
    const sample = buffer.subarray(0, Math.min(1024, buffer.length));
    for (let i = 0; i < sample.length; i += 1) {
      if (sample[i] === 0x00) nullCount += 1;
    }
    if (nullCount > 2) {
      throw new Error('File appears to be binary, not valid plain text.');
    }
  }

  const determinedMime = MIME_MAP[ext] || mimeType || 'application/octet-stream';
  const sha256 = computeSha256(buffer);

  return {
    valid: true,
    fileType: ext === 'jpeg' ? 'jpg' : ext === 'doc' ? 'docx' : ext,
    mimeType: determinedMime,
    sizeBytes: buffer.length,
    sha256,
  };
}

export function saveDocumentFile({ userId, documentId, filename, buffer }) {
  const safeName = sanitizeFilename(filename);
  const validated = validateFileBuffer({ filename: safeName, buffer });

  const userDir = path.join(STORAGE_DIR, sanitizeFilename(userId));
  const docDir = path.join(userDir, sanitizeFilename(documentId));
  mkdirSync(docDir, { recursive: true });

  const filePath = path.join(docDir, safeName);
  writeFileSync(filePath, buffer);

  const relativeStoragePath = path.join(sanitizeFilename(userId), sanitizeFilename(documentId), safeName);

  return {
    storagePath: relativeStoragePath,
    fullPath: filePath,
    filename: safeName,
    sizeBytes: validated.sizeBytes,
    sha256: validated.sha256,
    mimeType: validated.mimeType,
    fileType: validated.fileType,
  };
}

export function getDocumentFilePath(userId, documentId, filename) {
  const safeUser = sanitizeFilename(userId);
  const safeDoc = sanitizeFilename(documentId);
  const safeName = sanitizeFilename(filename);
  const filePath = path.join(STORAGE_DIR, safeUser, safeDoc, safeName);
  return existsSync(filePath) ? filePath : null;
}

export function readDocumentBuffer(userId, documentId, filename) {
  const filePath = getDocumentFilePath(userId, documentId, filename);
  if (!filePath) throw new Error('Stored document file not found.');
  return readFileSync(filePath);
}

export function deleteDocumentFile(userId, documentId) {
  try {
    const safeUser = sanitizeFilename(userId);
    const safeDoc = sanitizeFilename(documentId);
    const docDir = path.join(STORAGE_DIR, safeUser, safeDoc);
    if (existsSync(docDir)) {
      rmSync(docDir, { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

