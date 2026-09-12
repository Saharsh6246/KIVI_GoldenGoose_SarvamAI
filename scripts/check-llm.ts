import 'dotenv/config';
import { llmHealthcheck, MODELS, embedBatch } from '../src/lib/llm';
import { isStubMode } from '../src/lib/stub';

if (isStubMode()) {
  console.log('KIVI_OFFLINE_STUB=1 — running without a model. This is a test harness only.');
  process.exit(0);
}
console.log(`reasoning  ${MODELS.reasoning}`);
console.log(`extraction ${MODELS.extraction}`);
console.log(`embedding  ${MODELS.embedding}`);
const gen = await llmHealthcheck();
console.log(gen.ok ? `generate   OK — ${gen.detail}` : `generate   FAILED — ${gen.detail}`);
try {
  const e = await embedBatch(['hello world']);
  console.log(`embed      OK — ${e.vectors[0]?.length} dimensions in ${e.usage.latencyMs}ms`);
} catch (err: any) {
  console.log(`embed      FAILED — ${err?.message}`);
}
process.exit(gen.ok ? 0 : 1);
