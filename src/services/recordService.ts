import { vaultClient } from '@/services/vaultClient';
import type {
  AddressRecord,
  CertificationRecord,
  EducationRecord,
  EmploymentRecord,
  ProjectRecord,
  SkillRecord,
} from '../../shared/types';

export const recordService = {
  listAddresses(): Promise<AddressRecord[]> {
    return vaultClient.listProfileRecords<AddressRecord>('address');
  },
  saveAddress(input: Partial<AddressRecord> & Pick<AddressRecord, 'addressLine1'>): Promise<AddressRecord> {
    return vaultClient.saveProfileRecord<AddressRecord>('address', input as AddressRecord);
  },
  removeAddress(id: string): Promise<void> {
    return vaultClient.removeProfileRecord(id);
  },
  listEducation(): Promise<EducationRecord[]> {
    return vaultClient.listProfileRecords<EducationRecord>('education');
  },
  saveEducation(record: EducationRecord, documentId?: string): Promise<EducationRecord> {
    return vaultClient.saveProfileRecord<EducationRecord>('education', record, documentId);
  },
  removeEducation(id: string): Promise<void> {
    return vaultClient.removeProfileRecord(id);
  },
  listEmployment(): Promise<EmploymentRecord[]> {
    return vaultClient.listProfileRecords<EmploymentRecord>('employment');
  },
  saveEmployment(record: EmploymentRecord, documentId?: string): Promise<EmploymentRecord> {
    return vaultClient.saveProfileRecord<EmploymentRecord>('employment', record, documentId);
  },
  removeEmployment(id: string): Promise<void> {
    return vaultClient.removeProfileRecord(id);
  },
  listSkills(): Promise<SkillRecord[]> {
    return vaultClient.listProfileRecords<SkillRecord>('skill');
  },
  saveSkill(record: SkillRecord): Promise<SkillRecord> {
    return vaultClient.saveProfileRecord<SkillRecord>('skill', record);
  },
  removeSkill(id: string): Promise<void> {
    return vaultClient.removeProfileRecord(id);
  },
  listCertifications(): Promise<CertificationRecord[]> {
    return vaultClient.listProfileRecords<CertificationRecord>('certification');
  },
  saveCertification(record: CertificationRecord): Promise<CertificationRecord> {
    return vaultClient.saveProfileRecord<CertificationRecord>('certification', record);
  },
  removeCertification(id: string): Promise<void> {
    return vaultClient.removeProfileRecord(id);
  },
  listProjects(): Promise<ProjectRecord[]> {
    return vaultClient.listProfileRecords<ProjectRecord>('project');
  },
  saveProject(record: ProjectRecord): Promise<ProjectRecord> {
    return vaultClient.saveProfileRecord<ProjectRecord>('project', record);
  },
  removeProject(id: string): Promise<void> {
    return vaultClient.removeProfileRecord(id);
  },
};
