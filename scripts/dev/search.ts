import 'dotenv/config';
import { runTool, type ToolContext } from '../../src/lib/heykivi/tools';
const ctx: ToolContext = { now: Date.parse('2026-09-12T09:30:00+05:30'), trace: [], topScore: 0, retrievalMs: 0 };
const res: any = await runTool('search_dictations', { query: process.argv[2], limit: 8 }, ctx);
console.log('\nresults:');
for (const r of res.results) console.log(`  ${r.id}  ${r.spoken_at}  ${String(r.text).replace(/\n/g,' ').slice(0,84)}`);
if (res.later_statements_you_must_check) {
  console.log('\nlater_statements_you_must_check:');
  for (const r of res.later_statements_you_must_check) console.log(`  ${r.id}  ${r.said_on}  [${r.about}]  ${String(r.text).replace(/\n/g,' ').slice(0,84)}`);
} else console.log('\n(no revision candidates — field absent)');
