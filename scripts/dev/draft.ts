import 'dotenv/config';
import { runTool, type ToolContext } from '../../src/lib/heykivi/tools';
const ctx: ToolContext = { now: Date.parse('2026-09-12T09:30:00+05:30'), trace: [], topScore: 0, retrievalMs: 0 };
const res: any = await runTool('draft_from', { instruction: process.argv[2], text: process.argv[3] ?? 'placeholder source text', target_app: 'Mail' }, ctx);
console.log('\nsupporting_facts:', (res.supporting_facts ?? []).length);
for (const t of Object.keys(res.dated_statements_by_subject ?? {})) {
  console.log(`\ndated_statements_by_subject["${t}"]:`);
  for (const s of res.dated_statements_by_subject[t]) console.log(`  ${s.id}  ${s.said_on}  ${s.text.slice(0,90)}`);
}
console.log('\nsupporting_dictations:');
for (const d of res.supporting_dictations ?? []) console.log(`  ${d.id}  ${d.said_on}  ${d.text.slice(0,80)}`);
