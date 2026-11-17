import {
  MODEL_LICENSE,
  MODEL_LICENSE_URL,
  MODEL_REPOSITORY,
  MODEL_REVISION,
} from '@shared/constants';

export interface ModelFile {
  path: string;
  size: number;
  sha256?: string;
}

export interface ModelVariant {
  id: 'q8' | 'q4f16';
  label: string;
  dtype: string;
  runtime: 'webgpu' | 'wasm';
  quantization: string;
  files: ModelFile[];
  totalBytes: number;
  chatTemplateFile: string;
  modelFile: string;
}

const COMMON_FILES: ModelFile[] = [
  { path: 'config.json', size: 1359, sha256: 'c62bd6f68dc0d4d2436c86ad002a81ac6c8b9029837b8ea5f5404811eb465529' },
  { path: 'generation_config.json', size: 214, sha256: '64d86df2173901c58389974bde21f7d2ab9eb7d79f35a337753329d39cf265c0' },
  { path: 'tokenizer.json', size: 11422654, sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4' },
  { path: 'tokenizer_config.json', size: 5404, sha256: '443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0' },
  { path: 'added_tokens.json', size: 707, sha256: 'c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680' },
  { path: 'special_tokens_map.json', size: 613, sha256: '76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd' },
  { path: 'merges.txt', size: 1671853, sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5' },
  { path: 'vocab.json', size: 2776833, sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910' },
  { path: 'chat_template.jinja', size: 3645, sha256: 'b692e04b8bbd2723e45851897691899d7b4b5abb4974ed99ac60331b5001a99d' },
];

export const MODEL_VARIANTS: Record<'q8' | 'q4f16', ModelVariant> = {
  q8: {
    id: 'q8',
    label: 'Qwen3-0.6B Instruct — INT8 (CPU + WebGPU)',
    dtype: 'q8',
    runtime: 'wasm',
    quantization: 'INT8 / Q8',
    files: [
      ...COMMON_FILES,
      {
        path: 'onnx/model_quantized.onnx',
        size: 753999618,
        sha256: '5f939904362dc83215b0d029280a4b68aa4a97ba82ec9f23aaa8044efecfeb25',
      },
    ],
    totalBytes: 769_882_900,
    chatTemplateFile: 'chat_template.jinja',
    modelFile: 'onnx/model_quantized.onnx',
  },
  q4f16: {
    id: 'q4f16',
    label: 'Qwen3-0.6B Instruct — Q4F16 (WebGPU)',
    dtype: 'q4f16',
    runtime: 'webgpu',
    quantization: 'Q4F16',
    files: [
      ...COMMON_FILES,
      {
        path: 'onnx/model_q4f16.onnx',
        size: 648449396,
        sha256: '4ad5a67d818b55749eb4cad425ca542a7aa9ea66eba11a0d31ab6b81f35a182d',
      },
    ],
    totalBytes: 664_332_678,
    chatTemplateFile: 'chat_template.jinja',
    modelFile: 'onnx/model_q4f16.onnx',
  },
};

export const DEFAULT_MODEL_VARIANT: 'q8' = 'q8';

export const MODEL_METADATA = {
  repository: MODEL_REPOSITORY,
  revision: MODEL_REVISION,
  license: MODEL_LICENSE,
  licenseUrl: MODEL_LICENSE_URL,
  baseModel: 'minpeter/Qwen3-0.6B-Instruct',
  library: '@huggingface/transformers',
  runtime: 'ONNX Runtime Web (WebGPU / WASM)',
  contextWindow: 4096,
};

export function resolveModelUrl(filePath: string, revision = MODEL_REVISION): string {
  return `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${revision}/${filePath}`;
}

export function variantById(id: string): ModelVariant {
  return MODEL_VARIANTS[id as 'q8' | 'q4f16'] ?? MODEL_VARIANTS[DEFAULT_MODEL_VARIANT];
}
