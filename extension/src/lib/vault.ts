import { extractBranchFromDegree } from './classifier.ts';

export interface DemoVaultValue {
  key: string;
  label: string;
  value: string;
  source: string;
  confidence: number;
  sensitive?: boolean;
  category?: string;
  sourceDocumentName?: string;
  alternates?: Array<{ value: string; source: string; confidence: number }>;
}

export const demoVault: DemoVaultValue[] = [];

export function vaultRecord(vault: DemoVaultValue[] = demoVault): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of vault) {
    if (item.key && item.value) {
      map[item.key] = item.value;
    }
  }

  // Derive branch if not present
  if (!map['education.branch'] && map['education.degree']) {
    const derivedBranch = extractBranchFromDegree(map['education.degree']);
    if (derivedBranch) {
      map['education.branch'] = derivedBranch;
    }
  }

  // Derive first/last name if not present
  if (map['personal.fullName']) {
    const parts = map['personal.fullName'].trim().split(/\s+/);
    if (!map['personal.firstName'] && parts.length > 0) {
      map['personal.firstName'] = parts[0];
    }
    if (!map['personal.lastName'] && parts.length > 1) {
      map['personal.lastName'] = parts.slice(1).join(' ');
    }
  }

  return map;
}

export interface DemoCollection {
  id: string;
  name: string;
  description: string;
  sources: string[];
}

export const demoCollections: DemoCollection[] = [
  { id: 'all', name: 'All vault documents', description: 'Every available vault value.', sources: [] },
];

export function vaultForCollection(
  collectionId: string,
  vault: DemoVaultValue[] = demoVault,
  collections: DemoCollection[] = demoCollections,
): DemoVaultValue[] {
  const collection = collections.find((item) => item.id === collectionId);
  if (!collection || collection.id === 'all') return vault;
  return vault.filter((item) => {
    const docSource = item.sourceDocumentName || item.source;
    return collection.sources.includes(docSource);
  });
}

export interface DemoExtensionDocument {
  id: string;
  name: string;
  category: string;
  sizeLabel: string;
  source: string;
  fileType: string;
  keywords: string[];
}

export const demoExtensionDocuments: DemoExtensionDocument[] = [];

export interface UploadRecommendationResult {
  primary?: DemoExtensionDocument;
  candidates: DemoExtensionDocument[];
  required: boolean;
}

export function recommendDocumentsForUploadField(
  label: string,
  required = false
): UploadRecommendationResult {
  const norm = label.toLowerCase();
  const matched = demoExtensionDocuments.filter((doc) =>
    doc.keywords.some((kw) => norm.includes(kw))
  );

  return {
    primary: matched[0],
    candidates: matched,
    required,
  };
}
