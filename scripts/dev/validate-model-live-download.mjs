/**
 * Full-size live model download / resume validation.
 *
 * This is a validation harness, NOT a second product downloader. It exercises
 * the real pinned Hugging Face distribution endpoint end to end: redirects,
 * Content-Range, a controlled mid-stream interruption, Range resume, chunk
 * sizes, throughput, and an independent SHA-256 verification against the
 * trusted digest in the model registry. Bytes are streamed to a temporary file
 * in the OS-approved temp directory and removed on completion.
 *
 * It never modifies the application, IndexedDB, Cache Storage, or .model-cache/.
 *
 * Usage: node scripts/dev/validate-model-live-download.mjs
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registrySource = await readFile(path.join(root, 'ai/models/model-registry.ts'), 'utf8');
const constantsSource = await readFile(path.join(root, 'shared/constants.ts'), 'utf8');

const revision = /MODEL_REVISION\s*=\s*'([^']+)'/.exec(constantsSource)?.[1];
const repository = /MODEL_REPOSITORY\s*=\s*'([^']+)'/.exec(constantsSource)?.[1];
const modelMatch = /path:\s*'onnx\/model_quantized\.onnx',\s*size:\s*(\d+),\s*sha256:\s*'([0-9a-f]{64})'/.exec(registrySource);
if (!revision || !repository || !modelMatch) {
  throw new Error('Could not read pinned revision / model size / trusted digest from source.');
}
const expectedSize = Number(modelMatch[1]);
const expectedSha256 = modelMatch[2];
const modelFile = 'onnx/model_quantized.onnx';
const startUrl = `https://huggingface.co/${repository}/resolve/${revision}/${modelFile}`;

const tmpRoot = path.join(os.tmpdir(), 'formflow-live-download-validation');
await rm(tmpRoot, { recursive: true, force: true });
await mkdir(tmpRoot, { recursive: true });
const target = path.join(tmpRoot, 'model_quantized.onnx');

function nowMs() {
  return Date.now();
}

function fmt(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/** Follow redirects manually so the full redirect chain is recorded. */
async function openWithRedirects(url, init = {}) {
  const hops = [];
  let current = url;
  for (let i = 0; i < 10; i += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    const location = response.headers.get('location');
    hops.push({
      from: current.length > 160 ? `${current.slice(0, 160)}…` : current,
      status: response.status,
      location: location ? (location.length > 160 ? `${location.slice(0, 160)}…` : location) : null,
    });
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return { response, hops, finalUrl: current };
  }
  throw new Error('Too many redirects while resolving the model URL.');
}

async function appendStream(response, writerState, { interruptAfterBytes = 0, onChunk } = {}) {
  const reader = response.body.getReader();
  let aborted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      await new Promise((resolve, reject) => {
        if (!writerState.stream.write(value)) {
          writerState.stream.once('drain', resolve);
          writerState.stream.once('error', reject);
        } else resolve();
      });
      writerState.hasher.update(value);
      writerState.bytes += value.byteLength;
      writerState.chunks.push(value.byteLength);
      onChunk?.(writerState);
      if (interruptAfterBytes > 0 && writerState.bytes >= interruptAfterBytes) {
        aborted = true;
        await reader.cancel('controlled interruption');
        break;
      }
    }
  } finally {
    if (!aborted) reader.releaseLock();
  }
  return aborted;
}

async function closeWriter(writerState) {
  await new Promise((resolve, reject) => {
    writerState.stream.once('error', reject);
    writerState.stream.end(resolve);
  });
}

async function newWriter(startAt) {
  const handle = await open(target, startAt === 0 ? 'w' : 'a');
  const stream = handle.createWriteStream();
  // The CDN streams many small TLS frames; backpressure awaits one 'drain'
  // listener per chunk. Remove the emitter cap for this short-lived harness.
  stream.setMaxListeners(0);
  return { handle, stream, hasher: createHash('sha256'), bytes: startAt, chunks: [] };
}

const report = {
  generatedAt: new Date().toISOString(),
  startUrl,
  revision,
  repository,
  expectedSize,
  expectedSha256,
  initial: {},
  resume: {},
  interruptions: [],
  headers: {},
};

try {
  // ---- Phase 1: initial download, interrupted after the first chunk window ----
  const initialOpen = await openWithRedirects(startUrl);
  report.initial.redirectHops = initialOpen.hops;
  report.headers.initial = Object.fromEntries([...initialOpen.response.headers.entries()].slice(0, 30));
  report.initial.status = initialOpen.response.status;
  report.initial.finalUrlHost = new URL(initialOpen.finalUrl).host;
  if (initialOpen.response.status !== 200) {
    throw new Error(`Initial full request returned HTTP ${initialOpen.response.status}, expected 200.`);
  }
  const contentLength = Number(initialOpen.response.headers.get('content-length') ?? 0);
  report.initial.contentLength = contentLength;
  report.initial.acceptRanges = initialOpen.response.headers.get('accept-ranges');

  let writer = await newWriter(0);
  const phase1Start = nowMs();
  const interruptAt = 64 * 1024 * 1024; // interrupt after ~64 MiB (several 8 MiB-equivalent chunks)
  const interrupted = await appendStream(initialOpen.response, writer, { interruptAfterBytes: interruptAt });
  const phase1Ms = nowMs() - phase1Start;
  await closeWriter(writer);
  report.interruptions.push({ phase: 'initial', atBytes: writer.bytes, triggered: interrupted });
  report.initial = {
    ...report.initial,
    bytes: writer.bytes,
    durationMs: phase1Ms,
    throughputBytesPerSec: Math.round((writer.bytes / phase1Ms) * 1000),
    chunkCount: writer.chunks.length,
    firstChunks: writer.chunks.slice(0, 12),
    maxChunk: Math.max(...writer.chunks),
  };
  if (!interrupted) throw new Error('Controlled interruption did not trigger.');

  // ---- Phase 2: resume with Range, validating Content-Range ----
  const resumeStartByte = writer.bytes;
  const resumeOpen = await openWithRedirects(startUrl, { headers: { Range: `bytes=${resumeStartByte}-` } });
  report.resume.redirectHops = resumeOpen.hops;
  report.headers.resume = Object.fromEntries([...resumeOpen.response.headers.entries()].slice(0, 30));
  report.resume.status = resumeOpen.response.status;
  report.resume.requestedRange = `bytes=${resumeStartByte}-`;
  report.resume.contentRange = resumeOpen.response.headers.get('content-range');
  if (resumeOpen.response.status !== 206) {
    throw new Error(`Resume request returned HTTP ${resumeOpen.response.status}, expected 206.`);
  }
  const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(report.resume.contentRange ?? '');
  if (!cr || Number(cr[1]) !== resumeStartByte || Number(cr[3]) !== expectedSize) {
    throw new Error(`Invalid Content-Range for resume: ${report.resume.contentRange}`);
  }
  report.resume.contentRangeValid = true;
  writer = await newWriter(resumeStartByte);
  const phase2Start = nowMs();
  await appendStream(resumeOpen.response, writer);
  const phase2Ms = nowMs() - phase2Start;
  await closeWriter(writer);
  report.resume = {
    ...report.resume,
    downloadedBytes: writer.bytes - resumeStartByte,
    totalBytes: writer.bytes,
    durationMs: phase2Ms,
    throughputBytesPerSec: Math.round(((writer.bytes - resumeStartByte) / phase2Ms) * 1000),
  };

  if (writer.bytes !== expectedSize) {
    throw new Error(`Final size mismatch: ${writer.bytes} vs expected ${expectedSize}.`);
  }

  // ---- Phase 3: independent full SHA-256 of the assembled file ----
  const finalStat = await stat(target);
  report.final = { size: finalStat.size };
  const fileBytes = await readFile(target);
  const digest = createHash('sha256').update(fileBytes).digest('hex');
  report.final.sha256 = digest;
  report.final.sha256MatchesTrusted = digest === expectedSha256;
  report.final.totalDurationMs = phase1Ms + phase2Ms;
  report.final.averageThroughputBytesPerSec = Math.round((expectedSize / (phase1Ms + phase2Ms)) * 1000);
  report.passed = digest === expectedSha256 && finalStat.size === expectedSize;
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.passed = false;
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}
