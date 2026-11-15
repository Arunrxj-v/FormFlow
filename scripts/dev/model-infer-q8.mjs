import { env, pipeline } from '@huggingface/transformers';
import { readFileSync } from 'node:fs';
env.cacheDir = new URL('../../.model-cache', import.meta.url).pathname;
env.allowLocalModels = false;
console.log('loading...');
const t0 = Date.now();
const gen = await pipeline('text-generation', 'onnx-community/Qwen3-0.6B-Instruct-ONNX', {
  dtype: 'q8', device: 'cpu', revision: '54250909aca286a05b9d013c8af7a21859ee6ead',
});
console.log('loaded in', Date.now() - t0, 'ms');
gen.tokenizer.chat_template = readFileSync(new URL('../../.model-cache/chat_template.jinja', import.meta.url), 'utf8');
const messages = [
  { role: 'system', content: 'You are a strict information extraction engine. Return only JSON.' },
  { role: 'user', content: 'Extract the full name and email from this resume text. Return {"full_name":..., "email":...}. Text: "Arun Raj, arun@example.com, B.Tech Computer Science, XYZ University."' },
];
const t1 = Date.now();
const out = await gen(messages, { max_new_tokens: 80, do_sample: false });
console.log('inference ms', Date.now() - t1);
console.log(JSON.stringify(out[0].generated_text.at(-1), null, 2));
await gen.dispose();
