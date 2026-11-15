import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION } from '@shared/constants';
import type { FormFlowDB } from './schema';

let dbPromise: Promise<IDBPDatabase<FormFlowDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<FormFlowDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FormFlowDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('vaultMeta')) db.createObjectStore('vaultMeta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('vaultProfile')) db.createObjectStore('vaultProfile', { keyPath: 'id' });

        let documents;
        if (db.objectStoreNames.contains('documents')) documents = db.transaction('documents').objectStore('documents');
        else {
          documents = db.createObjectStore('documents', { keyPath: 'id' });
          documents.createIndex('by-checksum', 'checksum', { unique: true });
          documents.createIndex('by-status', 'status');
          documents.createIndex('by-created', 'createdAt');
        }

        if (!db.objectStoreNames.contains('documentFiles')) db.createObjectStore('documentFiles', { keyPath: 'documentId' });
        if (!db.objectStoreNames.contains('documentText')) db.createObjectStore('documentText', { keyPath: 'documentId' });

        let values;
        if (db.objectStoreNames.contains('extractedValues')) values = db.transaction('extractedValues').objectStore('extractedValues');
        else {
          values = db.createObjectStore('extractedValues', { keyPath: 'id' });
          values.createIndex('by-key', 'key');
          values.createIndex('by-document', 'sourceDocumentId');
          values.createIndex('by-updated', 'updatedAt');
        }

        let conflicts;
        if (db.objectStoreNames.contains('conflicts')) conflicts = db.transaction('conflicts').objectStore('conflicts');
        else {
          conflicts = db.createObjectStore('conflicts', { keyPath: 'id' });
          conflicts.createIndex('by-key', 'key');
          conflicts.createIndex('by-status', 'status');
        }

        let profiles;
        if (db.objectStoreNames.contains('profileRecords')) profiles = db.transaction('profileRecords').objectStore('profileRecords');
        else {
          profiles = db.createObjectStore('profileRecords', { keyPath: 'id' });
          profiles.createIndex('by-type', 'type');
        }

        if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', { keyPath: 'id' });
        let memberships;
        if (db.objectStoreNames.contains('collectionDocuments')) memberships = db.transaction('collectionDocuments').objectStore('collectionDocuments');
        else {
          memberships = db.createObjectStore('collectionDocuments', { keyPath: 'id' });
          memberships.createIndex('by-collection', 'collectionId');
          memberships.createIndex('by-document', 'documentId');
        }

        let history;
        if (db.objectStoreNames.contains('formHistory')) history = db.transaction('formHistory').objectStore('formHistory');
        else {
          history = db.createObjectStore('formHistory', { keyPath: 'id' });
          history.createIndex('by-created', 'createdAt');
        }

        let activity;
        if (db.objectStoreNames.contains('activity')) activity = db.transaction('activity').objectStore('activity');
        else {
          activity = db.createObjectStore('activity', { keyPath: 'id' });
          activity.createIndex('by-created', 'createdAt');
        }

        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });

        let jobs;
        if (db.objectStoreNames.contains('processingJobs')) jobs = db.transaction('processingJobs').objectStore('processingJobs');
        else {
          jobs = db.createObjectStore('processingJobs', { keyPath: 'id' });
          jobs.createIndex('by-document', 'documentId');
          jobs.createIndex('by-status', 'status');
        }

        if (!db.objectStoreNames.contains('modelMetadata')) db.createObjectStore('modelMetadata', { keyPath: 'id' });
      },
      blocked() {
        console.warn('[FormFlow] Database upgrade blocked by another open tab.');
      },
      blocking() {
        console.warn('[FormFlow] Closing database connection so another tab can upgrade.');
      },
    });
  }
  return dbPromise;
}

export async function deleteDatabase(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await deleteDB(DB_NAME);
}

export async function resetDatabaseForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await deleteDB(DB_NAME);
}
