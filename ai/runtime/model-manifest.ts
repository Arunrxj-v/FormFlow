/**
 * Versioned, validated model manifest and trusted release catalog.
 *
 * Trust model
 * -----------
 * Only immutable, pinned Hugging Face revisions are trusted. Mutable branch
 * aliases (`main`, `master`, `latest`, …) are never a security boundary and are
 * rejected as manifest revisions. Every file in a manifest must carry an exact
 * byte size and a trusted SHA-256 digest; unknown, missing, duplicated or
 * unhashed files cause validation to fail. The catalog contains exactly one
 * release — the verified Q8/INT8 baseline. No unverified model version is
 * introduced to demonstrate upgrade functionality.
 */
import {
  APP_VERSION,
  MODEL_METADATA_ID,
  MODEL_MANIFEST_VERSION,
  MODEL_RELEASE_ID,
  MODEL_REVISION,
  MODEL_VERSION,
} from '@shared/constants';
import type { ModelRuntime, ModelUpgradeInfo } from '@shared/types';
import { requiredModelStorageBytes } from '@shared/model-storage';
import { MODEL_VARIANTS, type ModelVariant } from '../models/model-registry';

export interface ModelManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ModelManifestCompatibility {
  minAppVersion: string;
  modelSchemaVersion: number;
}

export interface ModelManifest {
  /** Version of the manifest document schema itself. */
  schemaVersion: number;
  /** Stable, human-readable release identifier. */
  releaseId: string;
  /** Model semantic/algebraic version. */
  version: string;
  /** Logical model identifier (independent of revision). */
  modelId: string;
  /** Immutable commit revision (40 hex characters). */
  revision: string;
  quantization: string;
  runtime: ModelRuntime;
  backends: string[];
  minStorageBytes: number;
  contextWindow: number;
  files: ModelManifestFile[];
  chatTemplateFile: string;
  modelFile: string;
  compatibility: ModelManifestCompatibility;
  /** Set by the trusted catalog builder; never read from downloaded metadata. */
  trusted: boolean;
}

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const MUTABLE_ALIASES = new Set(['main', 'master', 'latest', 'head', 'stable', 'dev', 'develop']);
const ALLOWED_QUANTIZATION = new Set(['INT8', 'Q8', 'Q4F16', 'INT4']);
const ALLOWED_BACKENDS = new Set(['wasm', 'webgpu', 'onnx']);

// A manifest may only reference files that belong to a known-good variant,
// and must include every non-model file plus exactly one model file. This
// rejects unknown files, unexpected files and missing files.
const ALL_KNOWN_PATHS = new Set<string>(
  Object.values(MODEL_VARIANTS).flatMap((variant) => variant.files.map((file) => file.path)),
);
const REQUIRED_COMMON_PATHS = MODEL_VARIANTS.q8.files
  .map((file) => file.path)
  .filter((path) => !path.startsWith('onnx/'));

export class ModelManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelManifestError';
  }
}

function fail(message: string): never {
  throw new ModelManifestError(message);
}

/** Semver-ish comparison supporting `x.y.z` with an optional `-suffix`. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const core = value.trim().split('-')[0] ?? '';
    const parts = core.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
      fail(`Invalid version string: ${value}`);
    }
    return parts;
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! !== right[i]!) return left[i]! - right[i]!;
  }
  return 0;
}

/**
 * Validate every manifest field. This is deliberately strict: a manifest is
 * the trust root for a download, so any ambiguity is treated as rejection.
 */
export function validateManifest(input: unknown, options: { requireTrusted?: boolean } = {}): ModelManifest {
  if (!input || typeof input !== 'object') fail('Manifest must be an object.');
  const m = input as Record<string, unknown>;

  if (m.schemaVersion !== MODEL_MANIFEST_VERSION) {
    fail(`Unsupported manifest schema version: ${String(m.schemaVersion)}.`);
  }
  if (typeof m.releaseId !== 'string' || !/^[a-z0-9][a-z0-9._-]{3,80}$/.test(m.releaseId)) {
    fail('Manifest releaseId is invalid.');
  }
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) {
    fail('Manifest version is invalid.');
  }
  if (typeof m.modelId !== 'string' || m.modelId.length < 3 || m.modelId.length > 120) {
    fail('Manifest modelId is invalid.');
  }
  if (typeof m.revision !== 'string' || !HEX_40.test(m.revision) || MUTABLE_ALIASES.has(m.revision.toLowerCase())) {
    fail('Manifest revision must be an immutable 40-hex commit, not a branch alias.');
  }
  if (typeof m.quantization !== 'string' || !ALLOWED_QUANTIZATION.has(m.quantization.toUpperCase())) {
    fail(`Unsupported quantization: ${String(m.quantization)}.`);
  }
  if (m.runtime !== 'wasm' && m.runtime !== 'webgpu') fail('Manifest runtime is invalid.');
  if (!Array.isArray(m.backends) || m.backends.length === 0
    || m.backends.some((backend) => typeof backend !== 'string' || !ALLOWED_BACKENDS.has(backend))) {
    fail('Manifest inference backends are invalid.');
  }
  if (typeof m.minStorageBytes !== 'number' || !Number.isInteger(m.minStorageBytes) || m.minStorageBytes <= 0) {
    fail('Manifest minimum storage requirement is invalid.');
  }
  if (typeof m.contextWindow !== 'number' || !Number.isInteger(m.contextWindow)
    || m.contextWindow < 512 || m.contextWindow > 1_000_000) {
    fail('Manifest context window is invalid.');
  }
  if (typeof m.chatTemplateFile !== 'string' || typeof m.modelFile !== 'string') {
    fail('Manifest chatTemplateFile/modelFile are invalid.');
  }

  const compat = m.compatibility as Record<string, unknown> | undefined;
  if (!compat || typeof compat.minAppVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(compat.minAppVersion)
    || typeof compat.modelSchemaVersion !== 'number' || compat.modelSchemaVersion < 1) {
    fail('Manifest compatibility metadata is invalid.');
  }
  // Validate the version string via compareVersions (throws on malformed input).
  compareVersions(compat.minAppVersion, APP_VERSION);
  if (compareVersions(compat.minAppVersion, APP_VERSION) > 0) {
    fail(`Manifest requires an unsupported app version: ${compat.minAppVersion}.`);
  }

  if (!Array.isArray(m.files) || m.files.length === 0) fail('Manifest files must be a non-empty array.');
  const seen = new Set<string>();
  let sum = 0;
  for (const raw of m.files) {
    if (!raw || typeof raw !== 'object') fail('Manifest file entry is invalid.');
    const file = raw as Record<string, unknown>;
    if (typeof file.path !== 'string' || !/^[A-Za-z0-9._\-/]+$/.test(file.path)
      || file.path.startsWith('/') || file.path.includes('..')) {
      fail(`Manifest file path is invalid: ${String(file.path)}.`);
    }
    if (seen.has(file.path)) fail(`Duplicate manifest file: ${file.path}.`);
    seen.add(file.path);
    if (typeof file.size !== 'number' || !Number.isInteger(file.size) || file.size <= 0) {
      fail(`Manifest file size is invalid: ${file.path}.`);
    }
    if (typeof file.sha256 !== 'string' || !HEX_64.test(file.sha256)) {
      fail(`Manifest file is missing a trusted SHA-256: ${file.path}.`);
    }
    sum += file.size;
  }
  for (const path of seen) {
    if (!ALL_KNOWN_PATHS.has(path)) fail(`Manifest references an unknown model file: ${path}.`);
  }
  for (const path of REQUIRED_COMMON_PATHS) {
    if (!seen.has(path)) fail(`Manifest is missing a required model file: ${path}.`);
  }
  const onnxFiles = [...seen].filter((path) => path.startsWith('onnx/'));
  if (onnxFiles.length !== 1 || onnxFiles[0] !== m.modelFile) {
    fail('Manifest must list exactly one model file under onnx/.');
  }
  if (!seen.has(m.chatTemplateFile)) fail('Manifest chat template file is not listed in files.');
  if (!seen.has(m.modelFile)) fail('Manifest model file is not listed in files.');
  if (m.minStorageBytes < sum) {
    fail('Manifest minimum storage is smaller than the sum of its files.');
  }

  if (options.requireTrusted && m.trusted !== true) fail('Manifest is not from the trusted catalog.');

  return {
    schemaVersion: m.schemaVersion as number,
    releaseId: m.releaseId as string,
    version: m.version as string,
    modelId: m.modelId as string,
    revision: m.revision as string,
    quantization: m.quantization as string,
    runtime: m.runtime as ModelRuntime,
    backends: m.backends as string[],
    minStorageBytes: m.minStorageBytes as number,
    contextWindow: m.contextWindow as number,
    files: m.files as ModelManifestFile[],
    chatTemplateFile: m.chatTemplateFile as string,
    modelFile: m.modelFile as string,
    compatibility: m.compatibility as ModelManifestCompatibility,
    trusted: m.trusted === true,
  };
}

/** Build a trusted manifest from a known-good model variant. */
export function manifestFromVariant(variant: ModelVariant, overrides: Partial<ModelManifest> = {}): ModelManifest {
  return validateManifest({
    schemaVersion: MODEL_MANIFEST_VERSION,
    releaseId: MODEL_RELEASE_ID,
    version: MODEL_VERSION,
    modelId: MODEL_METADATA_ID,
    revision: MODEL_REVISION,
    quantization: manifestQuantization(variant),
    runtime: variant.runtime === 'webgpu' ? 'webgpu' : 'wasm',
    backends: variant.runtime === 'webgpu' ? ['webgpu'] : ['wasm', 'onnx'],
    minStorageBytes: requiredModelStorageBytes(variant.totalBytes),
    contextWindow: 4096,
    files: variant.files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256 ?? fail(`Known-good variant ${variant.id} file ${file.path} lacks a trusted SHA-256.`),
    })),
    chatTemplateFile: variant.chatTemplateFile,
    modelFile: variant.modelFile,
    compatibility: { minAppVersion: APP_VERSION, modelSchemaVersion: 1 },
    trusted: true,
    ...overrides,
  });
}

function manifestQuantization(variant: ModelVariant): string {
  if (variant.quantization.toUpperCase().includes('Q4F16')) return 'Q4F16';
  if (variant.quantization.toUpperCase().includes('INT8') || variant.id === 'q8') return 'INT8';
  return variant.quantization.toUpperCase();
}

/** The one trusted, immutable revision (the pinned commit, never an alias). */
export const TRUSTED_REVISION = MODEL_REVISION;

/** The trusted release catalog — currently the verified baseline only. */
export const TRUSTED_MODEL_MANIFESTS: ModelManifest[] = [
  manifestFromVariant(MODEL_VARIANTS.q8),
];

export function getTrustedManifest(releaseId: string): ModelManifest | null {
  return TRUSTED_MODEL_MANIFESTS.find((manifest) => manifest.releaseId === releaseId) ?? null;
}

export function latestTrustedManifest(): ModelManifest {
  return TRUSTED_MODEL_MANIFESTS.reduce((latest, candidate) => (
    compareVersions(candidate.version, latest.version) > 0 ? candidate : latest
  ));
}

/** Canonical digest of a manifest, used as an integrity identity. */
export function manifestDigest(manifest: ModelManifest): string {
  // node builds (tests) and browsers both expose SubtleCrypto; a pure JS
  // fallback keeps this deterministic in every runtime without async.
  const canonical = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    releaseId: manifest.releaseId,
    version: manifest.version,
    modelId: manifest.modelId,
    revision: manifest.revision,
    quantization: manifest.quantization,
    runtime: manifest.runtime,
    backends: [...manifest.backends].sort(),
    minStorageBytes: manifest.minStorageBytes,
    contextWindow: manifest.contextWindow,
    files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)),
    chatTemplateFile: manifest.chatTemplateFile,
    modelFile: manifest.modelFile,
    compatibility: manifest.compatibility,
    trusted: manifest.trusted,
  });
  // FNV-1a 64-bit style hash expressed as 16 hex chars — stable and sync.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i += 1) {
    const code = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Compatibility gate for moving from one release to another. */
export function isUpgradeCompatible(current: ModelManifest, target: ModelManifest): boolean {
  if (current.modelId !== target.modelId) return false;
  if (target.schemaVersion !== MODEL_MANIFEST_VERSION) return false;
  if (target.trusted !== true) return false;
  if (MUTABLE_ALIASES.has(target.revision.toLowerCase())) return false;
  if (!target.backends.some((backend) => backend === 'wasm')) return false;
  if (compareVersions(target.version, current.version) <= 0) return false;
  if (compareVersions(target.compatibility.minAppVersion, APP_VERSION) > 0) return false;
  if (current.revision === target.revision) return false;
  return true;
}

/**
 * Determine whether a compatible, trusted, validated upgrade exists. Honest by
 * construction: with a single trusted release this reports `available: false`.
 */
export function checkForUpgrade(currentReleaseId: string | null, currentVersion?: string): ModelUpgradeInfo {
  const current = currentReleaseId ? getTrustedManifest(currentReleaseId) : null;
  if (!current) {
    return {
      available: false,
      reason: currentReleaseId
        ? `Installed release ${currentReleaseId} is not in the trusted catalog; refusing to advertise an upgrade.`
        : 'No model is installed yet.',
    };
  }
  const latest = latestTrustedManifest();
  const currentVersionString = currentVersion ?? current.version;
  if (!isUpgradeCompatible({ ...current, version: currentVersionString }, latest)) {
    return {
      available: false,
      releaseId: latest.releaseId,
      version: latest.version,
      reason: 'The installed model is the latest verified release. No upgrade is available.',
    };
  }
  return { available: true, releaseId: latest.releaseId, version: latest.version };
}
