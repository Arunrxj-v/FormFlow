import { FormFlowError } from '@shared/errors';
import type {
  AddressRecord,
  CertificationRecord,
  EducationRecord,
  EmploymentRecord,
  ProfileRecordRow,
  ProjectRecord,
  SkillRecord,
  VaultField,
  VaultFieldInput,
  VaultProfile,
} from '@shared/types';
import { activityRepository, profileRecordRepository, vaultRepository } from '../database/repositories';

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FormFlowError('VALIDATION_FAILED', `${label} is required.`);
  }
  return value.trim();
}

export const profileService = {
  async getProfile(): Promise<VaultProfile> {
    return vaultRepository.getProfile();
  },

  async saveProfile(patch: Partial<Omit<VaultProfile, 'id'>>): Promise<VaultProfile> {
    const updated = await vaultRepository.saveProfile(patch);
    await activityRepository.record('vault_created', 'Profile updated', `${updated.name || 'Local profile'} · ${updated.email || 'no email'}`);
    return updated;
  },

  async listFields(): Promise<VaultField[]> {
    return vaultRepository.listFields();
  },

  async addField(input: VaultFieldInput): Promise<{ field: VaultField; conflictCreated: boolean }> {
    const result = await vaultRepository.addField(input);
    await activityRepository.record('document_updated', input.label || input.key, 'Vault value saved');
    return result;
  },

  async updateField(fieldId: string, value: string): Promise<VaultField> {
    const field = await vaultRepository.updateField(fieldId, value);
    await activityRepository.record('document_updated', field.label, 'Vault value edited');
    return field;
  },

  async deleteField(fieldId: string): Promise<void> {
    await vaultRepository.deleteField(fieldId);
    await activityRepository.record('document_removed', 'Vault value removed', 'Source document unchanged.');
  },

  async resolveConflict(fieldId: string, value: string): Promise<VaultField> {
    const field = await vaultRepository.resolveConflict(fieldId, value);
    await activityRepository.record('document_updated', field.label, 'Conflict resolved');
    return field;
  },

  async verifyField(fieldId: string): Promise<VaultField> {
    await vaultRepository.markVerified(fieldId);
    const field = (await vaultRepository.listFields()).find((item) => item.id === fieldId);
    if (!field) throw new FormFlowError('NOT_FOUND', 'Vault value not found.');
    await activityRepository.record('document_updated', field.label, 'Vault value verified by you');
    return field;
  },
};

type ProfileRecordType = ProfileRecordRow['type'];

function createRecordId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export const profileRecordService = {
  async list<T>(type: ProfileRecordType): Promise<T[]> {
    return profileRecordRepository.list<T>(type);
  },

  async listAddresses(): Promise<AddressRecord[]> {
    return profileRecordRepository.list<AddressRecord>('address');
  },

  async saveAddress(input: Partial<AddressRecord> & Pick<AddressRecord, 'addressLine1'>): Promise<AddressRecord> {
    const now = new Date().toISOString();
    const record: AddressRecord = {
      id: input.id || createRecordId('addr'),
      label: input.label || 'Primary address',
      addressLine1: requireId(input.addressLine1, 'Address line 1'),
      addressLine2: input.addressLine2,
      city: input.city ?? '',
      district: input.district,
      state: input.state ?? '',
      country: input.country ?? '',
      postalCode: input.postalCode ?? '',
      isPrimary: input.isPrimary ?? true,
      sourceDocumentId: input.sourceDocumentId,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    const saved = await profileRecordRepository.save<AddressRecord>('address', record, record.sourceDocumentId);
    await activityRepository.record('document_updated', saved.label, 'Address saved');
    return saved;
  },

  async removeAddress(id: string): Promise<void> {
    await profileRecordRepository.remove(id);
    await activityRepository.record('document_removed', 'Address removed', 'Source document unchanged.');
  },

  async listEducation(): Promise<EducationRecord[]> {
    return profileRecordRepository.list<EducationRecord>('education');
  },

  async saveEducation(record: EducationRecord, documentId?: string): Promise<EducationRecord> {
    if (!record.degree.trim() || !record.institution.trim()) {
      throw new FormFlowError('VALIDATION_FAILED', 'Degree and institution are required.');
    }
    const linkedDocumentId = documentId ?? record.documentId;
    const saved = await profileRecordRepository.save<EducationRecord>('education', {
      ...record,
      ...(linkedDocumentId ? { documentId: linkedDocumentId } : {}),
    }, linkedDocumentId);
    await activityRepository.record('document_updated', saved.degree, 'Education record saved');
    return saved;
  },

  async removeEducation(id: string): Promise<void> {
    await profileRecordRepository.remove(id);
    await activityRepository.record('document_removed', 'Education record removed', 'Source document unchanged.');
  },

  async listEmployment(): Promise<EmploymentRecord[]> {
    return profileRecordRepository.list<EmploymentRecord>('employment');
  },

  async saveEmployment(record: EmploymentRecord, documentId?: string): Promise<EmploymentRecord> {
    if (!record.role.trim() || !record.company.trim()) {
      throw new FormFlowError('VALIDATION_FAILED', 'Role and company are required.');
    }
    const linkedDocumentId = documentId ?? record.documentId;
    const saved = await profileRecordRepository.save<EmploymentRecord>('employment', {
      ...record,
      ...(linkedDocumentId ? { documentId: linkedDocumentId } : {}),
    }, linkedDocumentId);
    await activityRepository.record('document_updated', saved.role, 'Employment record saved');
    return saved;
  },

  async removeEmployment(id: string): Promise<void> {
    await profileRecordRepository.remove(id);
    await activityRepository.record('document_removed', 'Employment record removed', 'Source document unchanged.');
  },

  async listSkills(): Promise<SkillRecord[]> {
    return profileRecordRepository.list<SkillRecord>('skill');
  },

  async saveSkill(input: Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<SkillRecord> {
    if (!input.name.trim()) throw new FormFlowError('VALIDATION_FAILED', 'Skill name is required.');
    const now = new Date().toISOString();
    const record: SkillRecord = {
      id: input.id || createRecordId('skill'),
      name: input.name.trim(),
      category: input.category,
      level: Math.min(100, Math.max(0, input.level)),
      source: input.source || 'Added by you',
      sourceDocumentId: input.sourceDocumentId,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await profileRecordRepository.save<SkillRecord>('skill', record, record.sourceDocumentId);
    await activityRepository.record('document_updated', saved.name, 'Skill saved');
    return saved;
  },

  async removeSkill(id: string): Promise<void> {
    await profileRecordRepository.remove(id);
    await activityRepository.record('document_removed', 'Skill removed', 'Source document unchanged.');
  },

  async listCertifications(): Promise<CertificationRecord[]> {
    return profileRecordRepository.list<CertificationRecord>('certification');
  },

  async saveCertification(input: Omit<CertificationRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<CertificationRecord> {
    if (!input.name.trim()) throw new FormFlowError('VALIDATION_FAILED', 'Certification name is required.');
    const now = new Date().toISOString();
    const record: CertificationRecord = {
      id: input.id || createRecordId('cert'),
      name: input.name.trim(),
      issuer: input.issuer ?? '',
      issueDate: input.issueDate,
      expiryDate: input.expiryDate,
      sourceDocumentId: input.sourceDocumentId,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await profileRecordRepository.save<CertificationRecord>('certification', record, record.sourceDocumentId);
    await activityRepository.record('document_updated', saved.name, 'Certification saved');
    return saved;
  },

  async removeCertification(id: string): Promise<void> {
    await profileRecordRepository.remove(id);
    await activityRepository.record('document_removed', 'Certification removed', 'Source document unchanged.');
  },

  async listProjects(): Promise<ProjectRecord[]> {
    return profileRecordRepository.list<ProjectRecord>('project');
  },

  async saveProject(input: Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<ProjectRecord> {
    if (!input.title.trim()) throw new FormFlowError('VALIDATION_FAILED', 'Project title is required.');
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: input.id || createRecordId('project'),
      title: input.title.trim(),
      description: input.description,
      technologies: input.technologies,
      role: input.role,
      duration: input.duration,
      sourceDocumentId: input.sourceDocumentId,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await profileRecordRepository.save<ProjectRecord>('project', record, record.sourceDocumentId);
    await activityRepository.record('document_updated', saved.title, 'Project saved');
    return saved;
  },

  async removeProject(id: string): Promise<void> {
    await profileRecordRepository.remove(id);
    await activityRepository.record('document_removed', 'Project removed', 'Source document unchanged.');
  },
};
