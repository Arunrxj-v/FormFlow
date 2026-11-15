import { env, pipeline } from '@huggingface/transformers';
env.cacheDir = new URL('../../.model-cache', import.meta.url).pathname;
env.allowLocalModels = false;
console.log('loading...');
const t0 = Date.now();
let lastPct = -1;
const gen = await pipeline('text-generation', 'onnx-community/Qwen3-0.6B-Instruct-ONNX', {
  dtype: 'q8',
  device: 'cpu',
  revision: '54250909aca286a05b9d013c8af7a21859ee6ead',
  progress_callback: (p) => {
    if (p.status === 'progress' && p.file && p.progress != null) {
      const rounded = Math.floor(p.progress / 10) * 10;
      if (rounded !== lastPct) { lastPct = rounded; console.log('progress', p.file, p.progress.toFixed(1) + '%'); }
    } else if (p.status === 'done') { console.log('done', p.file); }
  },
});
console.log('loaded in', Date.now() - t0, 'ms');
const messages = [
  { role: 'system', content: 'You are a strict information extraction engine. Return only JSON.' },
  { role: 'user', content: 'Extract the full name and email from this resume text. Return {"full_name":..., "email":...}. Text: "Arun Raj, arun@example.com, B.Tech Computer Science, XYZ University."' },
];
const out = await gen(messages, { max_new_tokens: 64, do_sample: false, temperature: null });
console.log(JSON.stringify(out[0].generated_text, null, 2));
await gen.dispose();
