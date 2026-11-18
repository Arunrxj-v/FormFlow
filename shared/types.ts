export type DocumentStatus =
  | 'selected'
  | 'validating'
  | 'storing'
  | 'stored'
  | 'extracting_text'
  | 'running_ocr'
  | 'extracting_information'
  | 'validating_results'
  | 'review_required'
  | 'completed'
  | 'failed';

export type DocumentCategory =
  | 'Education'
  | 'Identity'
  | 'Employment'
  | 'Certifications'
  | 'Resumes'
  | 'Address proofs'
  | 'Financial'
  | 'Other'
  | (string & {});

export type FileKind = 'pdf' | 'docx' | 'txt' | 'jpg' | 'jpeg' | 'png' | 'other';

export type VaultCategory =
  | 'personal'
  | 'contact'
  | 'address'
  | 'education'
  | 'employment'
  | 'skills'
  | 'certifications'
  | 'projects'
  | 'identification'
  | 'other';

export type VerificationStatus = 'extracted' | 'user_verified' | 'outdated';
export type ExtractionMethod = 'deterministic' | 'ai' | 'manual' | 'derived';

export interface User {
  id: string;
  name: string;
  firstName: string;
  email: string;
  avatarInitials: string;
  accountType: 'Personal' | 'Pro' | 'Local';
}

export interface DocumentHistoryEntry {
  id: string;
  timestamp: string;
  action: string;
  detail: string;
}

export interface ExtractedFactEntity {
  key: string;
  label: string;
  value: string;
  page?: number;
  confidence?: number;
}

export interface VaultDocument {
  id: string;
  name: string;
  category: DocumentCategory;
  subcategory: string;
  status: DocumentStatus;
  fileType: FileKind;
  mimeType: string;
  sizeBytes: number;
  sizeLabel: string;
  uploadedAt: string;
  modifiedAt: string;
  source: 'device' | 'legacy-import';
  pageCount?: number;
  confidence?: number;
  failureReason?: string;
  processingError?: string;
  extractedCount?: number;
  previewTone?: string;
  checksum?: string;
  ocrUsed?: boolean;
  extractedTextStatus?: 'pending' | 'extracted' | 'failed';
  extractedText?: string;
  extractionVersion?: number;
  extractedAt?: string;
  ocrRequired?: boolean;
  ocrStatus?: OcrStatus;
  ocrLanguage?: string;
  ocrConfidence?: number;
  ocrPagesTotal?: number;
  ocrPagesCompleted?: number;
  extractionWarnings?: ExtractionWarning[];
  extractedEntities?: ExtractedFactEntity[];
  processingHistory?: DocumentHistoryEntry[];
  autofillRules?: string[];
  linkedRecordId?: string;
  linkedRecordTitle?: string;
  linkedRecordMeta?: string;
}

export interface FieldSource {
  documentId: string;
  documentName: string;
  page?: number;
  extractedAt?: string;
  /** Short supporting excerpt from the source document. */
  evidence?: string;
  blockId?: string;
  modelVersion?: string;
}

export interface FieldConflict {
  value: string;
  source: FieldSource;
  confidence: number;
  sourcePage?: number;
  documentDate?: string;
}

export interface VaultField {
  id: string;
  key: string;
  label: string;
  value: string;
  normalizedValue?: string;
  category: VaultCategory;
  source: FieldSource;
  sourcePage?: number;
  confidence: number;
  verificationStatus?: VerificationStatus;
  sensitive?: boolean;
  conflicts?: FieldConflict[];
  extractedAt?: string;
  lastUpdatedAt?: string;
  extractionMethod?: ExtractionMethod;
  userModified?: boolean;
}

export interface EducationRecord {
  id: string;
  level: string;
  degree: string;
  institution: string;
  university: string;
  period: string;
  status: 'Completed' | 'In progress';
  metrics: { label: string; value: string }[];
  documentId?: string;
  registrationNo: string;
  gpa: string;
  specialization: string;
  autofillTag: string;
  createdAt: string;
  lastSynced: string;
  sourceNote: string;
}

export interface EmploymentRecord {
  id: string;
  role: string;
  company: string;
  period: string;
  location: string;
  status: 'Current' | 'Completed';
  skills: string[];
  documentId?: string;
}

export interface Collection {
  id: string;
  vaultId: string;
  name: string;
  description: string;
  color: string;
  documentIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityItem {
  id: string;
  type:
    | 'document_added'
    | 'document_processed'
    | 'form_detected'
    | 'form_filled'
    | 'document_updated'
    | 'document_removed'
    | 'vault_created'
    | 'model_installed';
  title: string;
  detail: string;
  timestamp: string;
  relativeTime: string;
}

export interface FormHistoryItem {
  id: string;
  website: string;
  url: string;
  timestamp: string;
  dateLabel: string;
  fieldsDetected: number;
  fieldsFilled: number;
  fieldsReview: number;
  status: 'Completed' | 'Partially completed' | 'Cancelled' | 'Failed';
  documentsUsed: string[];
  duration: string;
}


export interface ExtensionConnection {
  installed: boolean;
  connected: boolean;
  version: string;
  browser: string;
  lastSync: string;
  shortcut: string;
}

export interface Preferences {
  confirmBeforeAutofill: boolean;
  requireSensitiveReview: boolean;
  allowLongAnswers: boolean;
  autoDownloadFiles: boolean;
  productNotifications: boolean;
  activityNotifications: boolean;
  compactMode: boolean;
  autoLockMinutes: number;
  ocrLanguage: string;
  /** Start the local model download after the first successful document upload. */
  autoDownloadModel: boolean;
}

export interface OnboardingState {
  completed: boolean;
  currentStep: number;
  vaultCreatedAt?: string;
}

export interface VaultRecord {
  id: string;
  /** Decrypted display name. New rows store this encrypted in nameEnc. */
  name: string;
  /** Encrypted vault display name; absent only in legacy rows awaiting migration. */
  nameEnc?: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  setupCompleted: boolean;
}


export interface VaultProfile {
  id: 'me';
  name: string;
  email: string;
  accountType: 'Personal' | 'Pro' | 'Local';
  createdAt: string;
  updatedAt: string;
}

export interface AddressRecord {
  id: string;
  label: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  district?: string;
  state: string;
  country: string;
  postalCode: string;
  isPrimary: boolean;
  sourceDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  category: 'Technical' | 'Tools' | 'Languages' | 'Certification';
  level: number;
  source: string;
  sourceDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CertificationRecord {
  id: string;
  name: string;
  issuer: string;
  issueDate?: string;
  expiryDate?: string;
  sourceDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  title: string;
  description?: string;
  technologies?: string[];
  role?: string;
  duration?: string;
  sourceDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredVaultProfileRow {
  id: 'me';
  profileEnc: string;
  updatedAt: string;
}

export interface VaultFieldInput {
  key: string;
  label: string;
  value: string;
  normalizedValue?: string;
  category: VaultCategory;
  source: FieldSource;
  sourcePage?: number;
  confidence: number;
  verificationStatus?: VerificationStatus;
  sensitive?: boolean;
  extractionMethod?: ExtractionMethod;
  userModified?: boolean;
  evidence?: string;
  sourceBlockId?: string;
  modelVersion?: string;
}

export interface ExtractionWarning {
  code: string;
  message: string;
  page?: number;
}

export interface DocumentExtractionMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
  headings?: Array<{ level: number; text: string }>;
  tableCount?: number;
  rowCount?: number;
  encoding?: string;
  bom?: boolean;
  lineEndings?: 'lf' | 'crlf' | 'mixed';
}

export type OcrStatus = 'not_required' | 'completed' | 'partial' | 'failed';

export interface OcrBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
  words?: OcrWord[];
}

export interface OcrPageDetails {
  page: number;
  language: string;
  confidence?: number;
  lines?: OcrLine[];
  words?: OcrWord[];
  warnings?: ExtractionWarning[];
}

export interface OcrExtractionDetails {
  status: OcrStatus;
  engine: string;
  engineVersion: string;
  language: string;
  processedAt: string;
  pagesAttempted: number;
  pagesCompleted: number;
  pagesFailed: number;
  averageConfidence?: number;
  warnings: ExtractionWarning[];
  pages: OcrPageDetails[];
}

export type DocumentStructureSchemaVersion = 1;
export type DocumentStructureFormat = 'pdf' | 'docx' | 'txt';
export type DocumentPageSemantics = 'physical' | 'logical';
export type DocumentPageType = 'text' | 'image_only' | 'blank' | 'unknown';
export type DocumentPageExtractionMethod = 'pdf_native' | 'docx_xml' | 'ocr' | 'mixed' | 'txt_native';
export type DocumentBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'list_item'
  | 'table'
  | 'table_row'
  | 'table_cell'
  | 'header'
  | 'footer'
  | 'caption'
  | 'image'
  | 'unknown';
export type DocumentExtractionProvenance =
  | 'pdf_native'
  | 'docx_xml'
  | 'ocr'
  | 'mixed'
  | 'inferred_from_layout'
  | 'txt_native';
export type DocumentCoordinateSpace = 'pdf_page_points' | 'ocr_render_pixels' | 'renderer_page_content_points' | 'renderer_page_points';
export type DocumentImagePositioning = 'inline' | 'anchored';
export type DocumentImageWrap =
  | 'inline'
  | 'square'
  | 'squareLeft'
  | 'squareRight'
  | 'tight'
  | 'through'
  | 'topAndBottom'
  | 'behind'
  | 'inFront'
  | 'unknown';
export interface DocumentImageAppearance {
  pageNumber: number;
  box?: DocumentGeometryBox;
  confidence: DocumentGeometryConfidence;
}
export interface DocumentStructureImageHeaderFooter {
  kind: 'header' | 'footer';
  variant: 'default' | 'first' | 'even';
  partName: string;
  definingSectionIndex: number;
  inheritedSectionIndexes?: number[];
}
export interface DocumentStructureImage {
  relationshipId?: string;
  sourcePart: string;
  mediaPart?: string;
  mimeType?: string;
  external: boolean;
  originalWidthPx?: number;
  originalHeightPx?: number;
  displayWidthPt: number;
  displayHeightPt: number;
  positioning: DocumentImagePositioning;
  wrap: DocumentImageWrap;
  alternativeText?: string;
  title?: string;
  placementId?: string;
  sourceParagraphBlockId?: string;
  sourceParagraphIndex?: number;
  placementIndex?: number;
  parentTableBlockId?: string;
  parentRowBlockId?: string;
  parentCellBlockId?: string;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  nestedTableDepth?: number;
  headerFooter?: DocumentStructureImageHeaderFooter;
  appearances?: DocumentImageAppearance[];
  captionBlockId?: string;
  captionText?: string;
  warnings: ExtractionWarning[];
}

export interface DocumentStructureBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  coordinateSpace: DocumentCoordinateSpace;
  pageWidth?: number;
  pageHeight?: number;
}

export interface DocumentStructureTextStyle {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  alignment?: 'left' | 'center' | 'right' | 'justified' | 'unknown';
  direction?: string;
  hyperlink?: boolean;
  styleId?: string;
  styleName?: string;
}

export interface DocumentStructureBlock {
  blockId: string;
  type: DocumentBlockType;
  text: string;
  pageId: string;
  pageNumber: number;
  order: number;
  parentId?: string;
  children?: string[];
  boundingBox?: DocumentStructureBoundingBox;
  confidence?: number;
  provenance: DocumentExtractionProvenance;
  layoutInferred?: boolean;
  sourceRef?: string;
  level?: number;
  style?: DocumentStructureTextStyle;
  listMarker?: string;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  rowSpan?: number;
  columnSpan?: number;
  columnBreakAfter?: boolean;
  image?: DocumentStructureImage;
  warnings?: ExtractionWarning[];
}

export interface DocumentStructurePageBounds {
  width: number;
  height: number;
  coordinateSpace: DocumentCoordinateSpace;
}

export interface DocumentStructureCoordinateConversion {
  from: 'ocr_render_pixels';
  to: 'pdf_page_points';
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

export interface DocumentStructurePage {
  pageId: string;
  pageNumber: number;
  pageKind: DocumentPageSemantics;
  pageType: DocumentPageType;
  extractionMethod: DocumentPageExtractionMethod;
  blockIds: string[];
  pageBounds?: DocumentStructurePageBounds;
  conversion?: DocumentStructureCoordinateConversion;
  warnings?: ExtractionWarning[];
}

export interface DocumentStructureSection {
  sectionId: string;
  headingBlockId?: string;
  level: number;
  title: string;
  blockIds: string[];
  pageStart: number;
  pageEnd: number;
  parentSectionId?: string;
}
export type DocumentHeaderFooterKind = 'header' | 'footer';
export type DocumentHeaderFooterVariant = 'default' | 'first' | 'even';
export type DocumentSectionBreakType = 'nextPage' | 'continuous' | 'evenPage' | 'oddPage';
export interface DocumentStructureHeaderFooterReference {
  kind: DocumentHeaderFooterKind;
  variant: DocumentHeaderFooterVariant;
  relationshipId?: string;
  partName?: string;
  inherited: boolean;
  definingSectionIndex: number;
  blockIds: string[];
}
export interface DocumentStructureDocxColumns {
  count: number;
  equalWidth: boolean;
  gapPt: number;
  separator: boolean;
  widthsPt?: number[];
  gapsPt?: number[];
  rightToLeft?: boolean;
}
export interface DocumentStructureDocxSection {
  sectionIndex: number;
  breakType: DocumentSectionBreakType;
  pageWidthPt: number;
  pageHeightPt: number;
  orientation: 'portrait' | 'landscape';
  margins: DocumentPaginationMargins;
  columnCount?: number;
  columns?: DocumentStructureDocxColumns;
  columnBreakCount?: number;
  titlePage?: boolean;
  pageNumberStart?: number;
  pageNumberFormat?: string;
  headers: DocumentStructureHeaderFooterReference[];
  footers: DocumentStructureHeaderFooterReference[];
}
export type DocumentFontResolutionSource =
  | 'embedded'
  | 'exact_local'
  | 'metric_substitute'
  | 'generic_fallback'
  | 'unavailable';
export interface DocumentFontFaceResolution {
  weight: number;
  style: 'normal' | 'italic';
  requestedFamily: string;
  resolvedFamily?: string;
  source: DocumentFontResolutionSource;
  exact: boolean;
  substituted: boolean;
  embedded: boolean;
  identity?: string;
  warning?: string;
}
export interface DocumentFontResolution {
  requestedFamily: string;
  resolvedFamily?: string;
  source: DocumentFontResolutionSource;
  exact: boolean;
  substituted: boolean;
  embedded: boolean;
  coverage: 'complete' | 'partial' | 'none';
  faces: DocumentFontFaceResolution[];
  warnings: string[];
}
export interface DocumentEmbeddedFont {
  family: string;
  style: 'regular' | 'bold' | 'italic' | 'boldItalic';
  partName?: string;
  relationshipId?: string;
  fontKey?: string;
  status: 'declared' | 'used' | 'dropped' | 'oversize' | 'malformed';
  warning?: string;
}
export interface DocumentThemeFonts {
  major?: string;
  minor?: string;
  majorEastAsia?: string;
  minorEastAsia?: string;
}
export interface DocumentStructureDocxLayout {
  evenAndOddHeaders: boolean;
  sections: DocumentStructureDocxSection[];
  fonts?: DocumentFontResolution[];
  embeddedFonts?: DocumentEmbeddedFont[];
  themeFonts?: DocumentThemeFonts;
}

export interface DocumentStructureTable {
  tableId: string;
  blockId: string;
  pageId: string;
  pageNumber: number;
  rowBlockIds: string[];
  columnCount: number;
  rowCount: number;
}

export interface DocumentStructureMetadata {
  pageCount: number;
  blockCount: number;
  sectionCount: number;
  tableCount: number;
  ocrPageCount: number;
  truncated: boolean;
}

export type DocumentPaginationStatus =
  | 'logical_fallback'
  | 'unavailable'
  | 'explicit_breaks'
  | 'renderer_reported_breaks'
  | 'renderer_derived_physical'
  | 'verified_physical';
export type DocumentPaginationMechanism =
  | 'none'
  | 'wordprocessingml_breaks'
  | 'wordprocessingml_last_rendered_breaks'
  | 'wordprocessingml_sections'
  | 'local_renderer';
export type DocumentPaginationPageKind =
  | 'logical'
  | 'explicit_break_segment'
  | 'renderer_reported'
  | 'renderer_derived_physical'
  | 'verified_physical';
export type DocumentPaginationBreakReason =
  | 'document_start'
  | 'explicit_page_break'
  | 'last_rendered_page_break'
  | 'section_break'
  | 'renderer_generated'
  | 'unknown';
export interface DocumentPaginationMargins {
  topPt: number;
  rightPt: number;
  bottomPt: number;
  leftPt: number;
  headerPt?: number;
  footerPt?: number;
}
export type DocumentGeometryConfidence =
  | 'exact'
  | 'renderer_approximate'
  | 'source_approximate'
  | 'text_order'
  | 'unavailable';
export interface DocumentGeometryBox {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: 'renderer_page_content_points' | 'renderer_page_points';
}
export interface DocumentPaginationLineGeometry {
  lineIndex: number;
  pageNumber: number;
  fragmentIndex: number;
  box: DocumentGeometryBox;
  columnIndex?: number;
  confidence: DocumentGeometryConfidence;
}
export interface DocumentPaginationCellGeometry {
  rowIndex: number;
  columnIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  pageNumber: number;
  fragmentIndex: number;
  box: DocumentGeometryBox;
  confidence: DocumentGeometryConfidence;
  repeatedHeader?: boolean;
}
export interface DocumentPaginationRowGeometry {
  rowIndex: number;
  pageNumber: number;
  fragmentIndex: number;
  box: DocumentGeometryBox;
  isHeaderRow?: boolean;
  isHeaderRepeat?: boolean;
  isContinuation?: boolean;
  hasContinuation?: boolean;
  confidence: DocumentGeometryConfidence;
  cells?: DocumentPaginationCellGeometry[];
}
export interface DocumentPaginationColumnGeometry {
  pageNumber: number;
  columnIndex: number;
  sectionIndex?: number;
  box: DocumentGeometryBox;
  widthPt: number;
  heightPt: number;
  confidence: DocumentGeometryConfidence;
  source: 'section_properties' | 'renderer_content' | 'mixed';
}
export interface DocumentPaginationGeometrySummary {
  lineCount: number;
  cellCount: number;
  columnCount: number;
  truncated: boolean;
}
export interface DocumentPaginationPage {
  pageNumber: number;
  pageKind: DocumentPaginationPageKind;
  blockIds: string[];
  breakReason: DocumentPaginationBreakReason;
  pageWidthPt?: number;
  pageHeightPt?: number;
  orientation?: 'portrait' | 'landscape';
  margins?: DocumentPaginationMargins;
  sectionIndex?: number;
  sectionIndexApproximate?: boolean;
  columnCount?: number;
  columns?: DocumentPaginationColumnGeometry[];
}
export interface DocumentPaginationBlockPage {
  blockId: string;
  startPageNumber: number;
  endPageNumber?: number;
  fragmentPages?: Array<{ pageNumber: number; fragmentIndex?: number }>;
  approximate?: boolean;
  geometryConfidence?: DocumentGeometryConfidence;
  boundingBox?: DocumentGeometryBox;
  lines?: DocumentPaginationLineGeometry[];
  tableRows?: DocumentPaginationRowGeometry[];
  rowIndex?: number;
  columnIndex?: number;
  rowSpan?: number;
  columnSpan?: number;
}
export interface DocumentPaginationInfo {
  status: DocumentPaginationStatus;
  mechanism: DocumentPaginationMechanism;
  pageCount: number;
  pages: DocumentPaginationPage[];
  blockPages: DocumentPaginationBlockPage[];
  warnings: ExtractionWarning[];
  renderer?: string;
  geometry?: DocumentPaginationGeometrySummary;
}

export interface DocumentStructure {
  schemaVersion: DocumentStructureSchemaVersion;
  extractionVersion: number;
  documentFormat: DocumentStructureFormat;
  pageSemantics: DocumentPageSemantics;
  pages: DocumentStructurePage[];
  blocks: DocumentStructureBlock[];
  sections: DocumentStructureSection[];
  tables: DocumentStructureTable[];
  readingOrder: string[];
  warnings: ExtractionWarning[];
  metadata: DocumentStructureMetadata;
  pagination?: DocumentPaginationInfo;
  docxLayout?: DocumentStructureDocxLayout;
}

export interface DocumentExtractionDetails {
  version: number;
  ocrRequired: boolean;
  pagesNeedingOcr: number[];
  warnings: ExtractionWarning[];
  metadata: DocumentExtractionMetadata;
  ocr?: OcrExtractionDetails;
  structure?: DocumentStructure;
}

export type DocumentIngestionStage =
  | 'validating'
  | 'checksumming'
  | 'duplicate'
  | 'encrypting'
  | 'extracting_text'
  | 'running_ocr'
  | 'encrypting_text'
  | 'storing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DocumentIngestionProgress {
  stage: DocumentIngestionStage;
  progress: number;
  message: string;
  page?: number;
  totalPages?: number;
}

export interface DocumentTextResult {
  documentId: string;
  text: string;
  pageTexts: string[];
  pageCount: number;
  method: StoredDocumentText['method'];
  warnings: ExtractionWarning[];
  metadata: DocumentExtractionMetadata;
  ocr?: OcrExtractionDetails;
  structure?: DocumentStructure;
  ocrRequired: boolean;
  pagesNeedingOcr?: number[];
  extractionVersion?: number;
  extractedAt?: string;
  truncated: boolean;
}

export interface DocumentRecord {
  id: string;
  vaultId: string;
  nameEnc: string;
  originalFilenameEnc: string;
  mimeType: string;
  extension: string;
  category: DocumentCategory;
  subcategory: string;
  status: DocumentStatus;
  fileType: FileKind;
  sizeBytes: number;
  sizeLabel: string;
  checksum: string;
  storageKey: string;
  source: 'device' | 'legacy-import';
  pageCount?: number;
  ocrUsed: boolean;
  extractedTextStatus: 'pending' | 'extracted' | 'failed';
  extractionVersion?: number;
  extractedAt?: string;
  ocrRequired?: boolean;
  ocrStatus?: OcrStatus;
  ocrLanguage?: string;
  ocrConfidence?: number;
  ocrPagesTotal?: number;
  ocrPagesCompleted?: number;
  metadata?: Record<string, unknown>;
  confidence?: number;
  failureReason?: string;
  processingError?: string;
  stageDetail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedValueRecord {
  id: string;
  key: string;
  /** Plaintext label exists only in pre-3.1 rows until the v2 migration encrypts it. */
  label: string;
  labelEnc?: string;
  valueEnc: string;
  normalizedValueEnc: string;
  category: VaultCategory;
  sourceDocumentId: string;
  sourcePage?: number;
  confidence: number;
  extractionMethod: ExtractionMethod;
  verificationStatus: VerificationStatus;
  sensitive: boolean;
  userModified: boolean;
  /** Authenticated supporting excerpt; absent on legacy rows. */
  evidenceEnc?: string;
  sourceBlockId?: string;
  modelVersion?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConflictRecord {
  id: string;
  key: string;
  /** Plaintext label exists only in pre-3.1 rows until the v2 migration encrypts it. */
  label: string;
  labelEnc?: string;
  existingValueEnc: string;
  existingSourceDocumentId: string;
  existingConfidence: number;
  newValueEnc: string;
  newSourceDocumentId: string;
  newConfidence: number;
  page?: number;
  status: 'open' | 'resolved';
  resolution?: 'kept_existing' | 'used_new' | 'edited' | 'outdated' | 'kept_both';
  createdAt: string;
  resolvedAt?: string;
}

export interface StoredDocumentText {
  documentId: string;
  textEnc: string;
  pageTextsEnc: string;
  pageCount: number;
  method: 'pdf-text' | 'docx' | 'ocr' | 'txt' | 'mixed';
  /** Optional encrypted extraction warnings/metadata; never plaintext. */
  extractionEnc?: string;
  createdAt: string;
}

export interface StoredDocumentFile {
  documentId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  ciphertext: Blob;
  iv: string;
  version: 2;
  /** AAD format used for the blob. Missing means legacy vault-wide AAD. */
  aadVersion?: 1 | 2;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessingJob {
  id: string;
  documentId: string;
  status: DocumentStatus;
  detail: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ProfileRecordRow {
  id: string;
  type: 'education' | 'employment' | 'skill' | 'certification' | 'project' | 'address';
  dataEnc: string;
  documentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionRow {
  id: string;
  vaultId: string;
  nameEnc: string;
  descriptionEnc: string;
  notesEnc: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionDocumentRow {
  id: string;
  collectionId: string;
  documentId: string;
}

export interface FormHistoryRow {
  id: string;
  websiteEnc: string;
  urlEnc: string;
  documentsUsedEnc: string;
  fieldsDetected: number;
  fieldsFilled: number;
  fieldsReview: number;
  status: 'Completed' | 'Partially completed' | 'Cancelled' | 'Failed';
  durationMs: number;
  createdAt: string;
}

export interface ActivityRow {
  id: string;
  type: ActivityItem['type'];
  titleEnc: string;
  detailEnc: string;
  createdAt: string;
}

export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface UnlockThrottleRecord {
  id: 'unlock-throttle';
  failedAttempts: number;
  lockedUntil: number;
  updatedAt: string;
}

export interface VaultMeta {
  id: 'meta';
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  wrappedDataKey: string;
  /** 1 or missing = Phase 3 vault-wide AAD; 2 = per-record AAD. */
  encryptionFormat?: 1 | 2;
  /** 2 = vault display name is encrypted with per-record AAD. */
  nameFormat?: 1 | 2;
  createdAt: string;
  passwordUpdatedAt: string;
}

export type ModelRuntime = 'webgpu' | 'wasm';
export type ModelStatus = 'not_installed' | 'downloading' | 'verifying' | 'installed' | 'initializing' | 'ready' | 'failed' | 'corrupt';

export interface InstalledModelRecord {
  id: string;
  modelId: string;
  releaseId?: string;
  manifestVersion?: number;
  version?: string;
  revision: string;
  dtype: string;
  runtime: ModelRuntime;
  status: ModelStatus;
  expectedBytes: number;
  downloadedBytes: number;
  files: Array<{ path: string; size: number; sha256?: string; sha256Computed?: string }>;
  installedAt?: string;
  lastVerifiedAt?: string;
  lastInitializedAt?: string;
  error?: string;
  selfTestLatencyMs?: number;
}

export interface StorageEstimate {
  usageBytes: number;
  quotaBytes: number;
  availableBytes: number;
  documentsBytes: number;
  modelBytes: number;
  persisted: boolean;
}

export interface ModelCapabilities {
  webgpu: boolean;
  webgpuAdapter?: string;
  wasm: boolean;
  hardwareConcurrency: number;
  deviceMemoryGb?: number;
}

export interface ModelUpgradeInfo {
  available: boolean;
  releaseId?: string;
  version?: string;
  reason?: string;
  manifestVersion?: number;
  checkedAt?: string;
}

export type ModelLifecyclePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'self_testing'
  | 'switching'
  | 'completed'
  | 'failed'
  | 'rolled_back';

export type ModelLifecycleStatus = 'idle' | 'in_progress' | 'completed' | 'failed' | 'rolled_back';

/**
 * Journaled lifecycle state. Exactly one record (`MODEL_LIFECYCLE_ID`) tracks
 * the active release, the last known-good release retained for rollback, and
 * the phase/status of any in-flight upgrade or rollback. It is written before
 * each irreversible step so an interrupted upgrade can be recovered on the
 * next startup.
 */
export interface ModelLifecycleState {
  id: string;
  activeReleaseId: string | null;
  previousReleaseId: string | null;
  operation: 'upgrade' | 'rollback' | null;
  phase: ModelLifecyclePhase;
  status: ModelLifecycleStatus;
  targetReleaseId: string | null;
  targetVersion?: string;
  targetRevision?: string;
  manifestVersion?: number;
  failureReason?: string;
  startedAt?: string;
  updatedAt: string;
  switchedAt?: string;
  lastRollbackAt?: string;
}

export interface ModelRollbackStatus {
  available: boolean;
  previousReleaseId?: string | null;
  lastRollbackAt?: string;
  lastReason?: string;
}

export interface ModelStatusSnapshot {
  status: ModelStatus;
  ready: boolean;
  record: InstalledModelRecord | null;
  previousRecord?: InstalledModelRecord | null;
  lastInstallError?: string;
  availableUpgrade?: ModelUpgradeInfo;
  lifecycle?: ModelLifecycleState;
  rollback?: ModelRollbackStatus;
  failureDetails?: string;
  capabilities: ModelCapabilities;
  preferredVariant: 'q8' | 'q4f16';
  storage: StorageEstimate | null;
  message: string;
  inference?: {
    active: boolean;
    generatedTokens: number;
  };
  progress?: {
    phase: 'checking' | 'downloading' | 'verifying' | 'ready';
    percent: number;
    filePath: string;
    downloadedBytes: number;
    totalBytes: number;
  };
}

export interface ModelSelfTestResult {
  ok: boolean;
  latencyMs?: number;
  loadMs?: number;
  runtime: ModelRuntime;
  variant: 'q8' | 'q4f16';
  message: string;
}

export interface DocumentExtractionSummary {
  documentId: string;
  candidates: number;
  deterministic: number;
  ai: number;
  conflicts: number;
  aiUsed: boolean;
  modelVersion?: string;
  warnings: string[];
}
