import type { EducationRecord, EmploymentRecord } from './types';
import { getStoredToken } from './apiClient';

function getStorageKey(type: string): string {
  const token = getStoredToken();
  const userHash = token ? token.slice(-12) : 'guest';
  return `formflow.records.${type}.${userHash}`;
}

function loadRecords<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function saveRecords<T>(key: string, data: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Ignore storage quota
  }
}

export const recordService = {
  isDemo: false,

  async listEducation(): Promise<EducationRecord[]> {
    return loadRecords<EducationRecord>(getStorageKey('education'));
  },

  async listEmployment(): Promise<EmploymentRecord[]> {
    return loadRecords<EmploymentRecord>(getStorageKey('employment'));
  },

  async saveEducation(record: EducationRecord): Promise<EducationRecord> {
    const key = getStorageKey('education');
    const records = loadRecords<EducationRecord>(key);
    const exists = records.some((item) => item.id === record.id);
    const updated = exists ? records.map((item) => (item.id === record.id ? record : item)) : [record, ...records];
    saveRecords(key, updated);
    return record;
  },

  async removeEducation(id: string): Promise<void> {
    const key = getStorageKey('education');
    const records = loadRecords<EducationRecord>(key);
    saveRecords(key, records.filter((item) => item.id !== id));
  },

  async saveEmployment(record: EmploymentRecord): Promise<EmploymentRecord> {
    const key = getStorageKey('employment');
    const records = loadRecords<EmploymentRecord>(key);
    const exists = records.some((item) => item.id === record.id);
    const updated = exists ? records.map((item) => (item.id === record.id ? record : item)) : [record, ...records];
    saveRecords(key, updated);
    return record;
  },

  async removeEmployment(id: string): Promise<void> {
    const key = getStorageKey('employment');
    const records = loadRecords<EmploymentRecord>(key);
    saveRecords(key, records.filter((item) => item.id !== id));
  },
};
