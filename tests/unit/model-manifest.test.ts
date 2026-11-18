import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkForUpgrade,
  compareVersions,
  isUpgradeCompatible,
  manifestDigest,
  manifestFromVariant,
  TRUSTED_MODEL_MANIFESTS,
  validateManifest,
  ModelManifestError,
} from '../../ai/runtime/model-manifest';
import { MODEL_VARIANTS } from '../../ai/models/model-registry';

const trusted = TRUSTED_MODEL_MANIFESTS[0]!;

function clone(overrides: Record<string, unknown> = {}) {
  return JSON.parse(JSON.stringify({ ...trusted, ...overrides }));
}

test('the trusted catalog builds a valid baseline manifest', () => {
  assert.ok(trusted.trusted);
  assert.match(trusted.revision, /^[0-9a-f]{40}$/);
  assert.equal(trusted.files.length, MODEL_VARIANTS.q8.files.length);
  assert.deepEqual(validateManifest(clone()), trusted);
  assert.match(manifestDigest(trusted), /^[0-9a-f]{16}$/);
});

test('manifestFromVariant produces a trusted, valid manifest', () => {
  const built = manifestFromVariant(MODEL_VARIANTS.q8);
  assert.equal(built.releaseId, trusted.releaseId);
  assert.equal(built.revision, trusted.revision);
});

test('a mutable branch alias is rejected as a revision', () => {
  assert.throws(() => validateManifest(clone({ revision: 'main' })), ModelManifestError);
  assert.throws(() => validateManifest(clone({ revision: 'master' })), ModelManifestError);
});

test('unknown, unexpected and missing files are rejected', () => {
  assert.throws(() => validateManifest(clone({
    files: [...trusted.files, { path: 'onnx/surprise.bin', size: 1, sha256: 'a'.repeat(64) }],
  })), /unknown model file/i);
  const withoutConfig = clone({ files: trusted.files.filter((f: { path: string }) => f.path !== 'config.json') });
  assert.throws(() => validateManifest(withoutConfig), /missing a required model file/i);
  assert.throws(() => validateManifest(clone({ modelFile: 'onnx/not-listed.onnx' })), /not listed in files|exactly one model file/i);
});

test('missing or invalid checksums and sizes are rejected', () => {
  const noHash = clone();
  delete noHash.files[0].sha256;
  assert.throws(() => validateManifest(noHash), /trusted SHA-256/i);
  assert.throws(() => validateManifest(clone({ files: [{ ...trusted.files[0], sha256: 'xyz' }, ...trusted.files.slice(1)] })), /trusted SHA-256/i);
  assert.throws(() => validateManifest(clone({ files: [{ ...trusted.files[0], size: -1 }, ...trusted.files.slice(1)] })), /size is invalid/i);
});

test('unsupported quantization, runtime and backends are rejected', () => {
  assert.throws(() => validateManifest(clone({ quantization: 'FP32' })), /quantization/i);
  assert.throws(() => validateManifest(clone({ runtime: 'cuda' })), /runtime/i);
  assert.throws(() => validateManifest(clone({ backends: ['remote-api'] })), /backends/i);
});

test('a future app-version requirement is rejected', () => {
  assert.throws(() => validateManifest(clone({ compatibility: { minAppVersion: '99.0.0', modelSchemaVersion: 1 } })), /unsupported app version/i);
});

test('untrusted manifests are rejected when required', () => {
  assert.throws(() => validateManifest(clone({ trusted: false }), { requireTrusted: true }), /not from the trusted catalog/i);
});

test('upgrade compatibility is strict and version-ordered', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  const newer = clone({ version: '0.7.0-int8-r1', revision: 'a'.repeat(40) });
  assert.equal(isUpgradeCompatible(trusted, newer), true);
  assert.equal(isUpgradeCompatible(trusted, trusted), false);
  assert.equal(isUpgradeCompatible(trusted, clone({ ...newer, trusted: false })), false);
  assert.equal(isUpgradeCompatible(trusted, clone({ ...newer, modelId: 'other-model' })), false);
});

test('the trusted catalog honestly reports no upgrade', () => {
  assert.equal(checkForUpgrade(trusted.releaseId, trusted.version).available, false);
  assert.equal(checkForUpgrade(null, undefined).available, false);
  assert.equal(checkForUpgrade('untrusted-release', trusted.version).available, false);
});
