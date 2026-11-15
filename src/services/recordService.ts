import { profileRecordService } from '../../core/application/profile-service';
import type {
  AddressRecord,
  CertificationRecord,
  EducationRecord,
  EmploymentRecord,
  ProjectRecord,
  SkillRecord,
} from '../../shared/types';

/**
 * Compatibility facade over the local profile-record service.
 * Keeps the existing page API while the business logic lives in core/application.
 */
export const recordService = {
  listAddresses(): Promise<AddressRecord[]> {
    return profileRecordService.listAddresses();
  },

  saveAddress(input: Partial<AddressRecord> & Pick<AddressRecord, 'addressLine1'>): Promise<AddressRecord> {
    return profileRecordService.saveAddress(input);
  },

  removeAddress(id: string): Promise<void> {
    return profileRecordService.removeAddress(id);
  },

  listEducation(): Promise<EducationRecord[]> {
    return profileRecordService.listEducation();
  },

  saveEducation(record: EducationRecord, documentId?: string): Promise<EducationRecord> {
    return profileRecordService.saveEducation(record, documentId);
  },

  removeEducation(id: string): Promise<void> {
    return profileRecordService.removeEducation(id);
  },

  listEmployment(): Promise<EmploymentRecord[]> {
    return profileRecordService.listEmployment();
  },

  saveEmployment(record: EmploymentRecord, documentId?: string): Promise<EmploymentRecord> {
    return profileRecordService.saveEmployment(record, documentId);
  },

  removeEmployment(id: string): Promise<void> {
    return profileRecordService.removeEmployment(id);
  },

  listSkills(): Promise<SkillRecord[]> {
    return profileRecordService.listSkills();
  },

  saveSkill(record: SkillRecord): Promise<SkillRecord> {
    return profileRecordService.saveSkill(record);
  },

  removeSkill(id: string): Promise<void> {
    return profileRecordService.removeSkill(id);
  },

  listCertifications(): Promise<CertificationRecord[]> {
    return profileRecordService.listCertifications();
  },

  saveCertification(record: CertificationRecord): Promise<CertificationRecord> {
    return profileRecordService.saveCertification(record);
  },

  removeCertification(id: string): Promise<void> {
    return profileRecordService.removeCertification(id);
  },

  listProjects(): Promise<ProjectRecord[]> {
    return profileRecordService.listProjects();
  },

  saveProject(record: ProjectRecord): Promise<ProjectRecord> {
    return profileRecordService.saveProject(record);
  },

  removeProject(id: string): Promise<void> {
    return profileRecordService.removeProject(id);
  },
};
