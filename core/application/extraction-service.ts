import { FormFlowError } from '@shared/errors';
import type { DocumentExtractionSummary } from '@shared/types';
import { activityRepository, documentRepository, vaultRepository } from '../database/repositories';
import { candidateToField, type ExtractedCandidate } from '../extraction/deterministic';
import { extractInformation, type LocalModelRunner } from '../extraction/pipeline';
import { profileRecordService } from './profile-service';

export interface DocumentExtractionDependencies {
  /** Local model runner. When absent, deterministic extraction still runs. */
  model?: LocalModelRunner;
  modelVersion?: string;
}

/**
 * Extract structured profile candidates from an already-ingested document.
 *
 * Deterministic extraction always runs. A local-model runner may add
 * grounded candidates, but model output is validated, source-grounded and
 * merged without overriding deterministic values. Values are persisted with
 * encrypted provenance; conflicts never overwrite verified values.
 */
export async function extractDocumentInformation(
  documentId: string,
  deps: DocumentExtractionDependencies = {},
): Promise<DocumentExtractionSummary> {
  const meta = await documentRepository.get(documentId);
  if (!meta) throw new FormFlowError('NOT_FOUND', 'Document not found.');
  const text = await documentRepository.getText(documentId);
  if (!text) throw new FormFlowError('NOT_FOUND', 'Extracted document text is not available.');
  if (!text.text.trim()) {
    throw new FormFlowError('EMPTY_DOCUMENT', 'This document has no extractable text to build profile values from.');
  }

  const outcome = await extractInformation({
    documentId,
    documentName: meta.name,
    text: text.text,
    pageTexts: text.pageTexts,
    ...(text.extraction?.structure ? { structure: text.extraction.structure } : {}),
    ...(meta.row.category ? { category: meta.row.category } : {}),
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.modelVersion ? { modelVersion: deps.modelVersion } : {}),
  });

  let conflicts = 0;
  let saved = 0;
  for (const candidate of outcome.candidates) {
    const field = candidateToField(candidate);
    const result = await vaultRepository.addField({
      ...field,
      source: {
        documentId,
        documentName: meta.name,
        ...(candidate.page ? { page: candidate.page } : {}),
        ...(candidate.supportingText ? { evidence: candidate.supportingText } : {}),
        ...(candidate.sourceBlockId ? { blockId: candidate.sourceBlockId } : {}),
        ...(candidate.modelVersion ? { modelVersion: candidate.modelVersion } : {}),
      },
      sourcePage: candidate.page,
    });
    saved += 1;
    if (result.conflictCreated) conflicts += 1;
  }

  await synthProfileRecords(documentId, meta.name, outcome.candidates);

  if (saved > 0 || conflicts > 0) {
    try {
      await activityRepository.record(
        'document_processed',
        meta.name,
        `${saved} profile value${saved === 1 ? '' : 's'} linked${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? '' : 's'} to review` : ''}${outcome.aiUsed ? ' · local AI assisted' : ''}`,
      );
    } catch {
      // Activity is secondary to the extracted values.
    }
  }

  return {
    documentId,
    candidates: saved,
    deterministic: outcome.deterministicCount,
    ai: outcome.aiCount,
    conflicts,
    aiUsed: outcome.aiUsed,
    ...(outcome.modelVersion ? { modelVersion: outcome.modelVersion } : {}),
    warnings: outcome.warnings,
  };
}


function candidateValue(candidates: Map<string, ExtractedCandidate>, key: string): string {
  return candidates.get(key)?.value.trim() ?? '';
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isExtractionRecord(record: { sourceNote?: string }): boolean {
  return Boolean(record.sourceNote?.startsWith('Extracted from'));
}

/**
 * Keep the flat vault fields and the structured record pages consistent.
 * Records are only synthesised from grounded candidates, never overwrite
 * user-edited records, and remain editable in the existing profile pages.
 */
async function synthProfileRecords(
  documentId: string,
  documentName: string,
  candidates: ExtractedCandidate[],
): Promise<void> {
  if (candidates.length === 0) return;
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const now = new Date().toISOString();
  const sourceNote = `Extracted from ${documentName}; review and verify before using.`;

  const degree = candidateValue(byKey, 'education.degree');
  const institution = candidateValue(byKey, 'education.institution') || candidateValue(byKey, 'education.university');
  if (degree && institution) {
    try {
      const existing = await profileRecordService.listEducation();
      const duplicate = existing.find((record) => sameText(record.degree, degree) && sameText(record.institution, institution));
      if (!duplicate) {
        const university = candidateValue(byKey, 'education.university');
        const branch = candidateValue(byKey, 'education.branch');
        const gpa = candidateValue(byKey, 'education.cgpa') || candidateValue(byKey, 'education.percentage');
        const registrationNo = candidateValue(byKey, 'education.registrationNumber');
        const year = candidateValue(byKey, 'education.graduationYear');
        await profileRecordService.saveEducation({
          id: `edu_${crypto.randomUUID()}`,
          level: /master|mba|m\.?tech|m\.?sc|postgraduate/i.test(degree) ? 'Postgraduate / Master' : /phd|doctor/i.test(degree) ? 'Doctorate' : 'Tertiary / Degree',
          degree,
          institution,
          university,
          period: year,
          status: 'Completed',
          metrics: [
            { label: 'CGPA score', value: gpa || '—' },
            { label: 'Registration no.', value: registrationNo || '—' },
            { label: 'Specialization', value: branch || '—' },
          ],
          registrationNo,
          gpa,
          specialization: branch,
          autofillTag: 'edu.degree',
          createdAt: now,
          lastSynced: 'Extracted just now',
          sourceNote,
        }, documentId);
      }
    } catch {
      // Structured records are a presentation layer over the flat vault fields.
    }
  }

  const role = candidateValue(byKey, 'employment.jobTitle');
  const company = candidateValue(byKey, 'employment.employer');
  if (role && company) {
    try {
      const existing = await profileRecordService.listEmployment();
      const duplicate = existing.find((record) => sameText(record.role, role) && sameText(record.company, company));
      if (!duplicate) {
        await profileRecordService.saveEmployment({
          id: `emp_${crypto.randomUUID()}`,
          role,
          company,
          period: candidateValue(byKey, 'employment.experience'),
          location: '',
          status: 'Current',
          skills: candidateValue(byKey, 'skills.technical')
            .split(/[,;|]/)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .slice(0, 20),
        }, documentId);
      }
    } catch {
      // Keep the flat values even if the structured record cannot be saved.
    }
  }

  const line1 = candidateValue(byKey, 'contact.addressLine1');
  if (line1) {
    try {
      const existing = await profileRecordService.listAddresses();
      const duplicate = existing.find((record) => sameText(record.addressLine1, line1)
        && sameText(record.city, candidateValue(byKey, 'contact.city')));
      if (!duplicate) {
        await profileRecordService.saveAddress({
          label: 'Primary address',
          addressLine1: line1,
          city: candidateValue(byKey, 'contact.city'),
          state: candidateValue(byKey, 'contact.state'),
          country: candidateValue(byKey, 'contact.country'),
          postalCode: candidateValue(byKey, 'contact.postalCode'),
          isPrimary: existing.length === 0,
          sourceDocumentId: documentId,
        });
      }
    } catch {
      // Address records are optional; flat values remain available.
    }
  }

  const skills = candidateValue(byKey, 'skills.technical');
  if (skills) {
    try {
      const existing = await profileRecordService.listSkills();
      const existingNames = new Set(existing.map((record) => record.name.toLowerCase()));
      for (const name of skills.split(/[,;|]/).map((entry) => entry.trim()).filter(Boolean).slice(0, 25)) {
        if (existingNames.has(name.toLowerCase())) continue;
        await profileRecordService.saveSkill({
          name,
          category: 'Technical',
          level: 60,
          source: `Extracted from ${documentName}`,
          sourceDocumentId: documentId,
        });
        existingNames.add(name.toLowerCase());
      }
    } catch {
      // Skills are a convenience view; flat values remain available.
    }
  }

  const certification = candidateValue(byKey, 'certifications.name');
  if (certification) {
    try {
      const existing = await profileRecordService.listCertifications();
      if (!existing.some((record) => sameText(record.name, certification))) {
        await profileRecordService.saveCertification({
          name: certification,
          issuer: '',
          sourceDocumentId: documentId,
        });
      }
    } catch {
      // Certifications are optional.
    }
  }

  const projectTitle = candidateValue(byKey, 'projects.title');
  if (projectTitle) {
    try {
      const existing = await profileRecordService.listProjects();
      if (!existing.some((record) => sameText(record.title, projectTitle))) {
        await profileRecordService.saveProject({
          title: projectTitle,
          description: candidateValue(byKey, 'projects.description') || undefined,
          sourceDocumentId: documentId,
        });
      }
    } catch {
      // Projects are optional.
    }
  }
}
