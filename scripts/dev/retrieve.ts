/**
 * Dump exactly what a search returns, ranked, with its score breakdown.
 *   npx tsx scripts/dev/retrieve.ts "some query" --time yesterday --app Slack --limit 8
 */
import 'dotenv/config';
import { retrieveDictations } from '../../src/lib/retrieval';
import { parseTimeExpression } from '../../src/lib/heykivi/time';
import { formatLocal } from '../../src/lib/tz';

const args = process.argv.slice(2);
const query = args[0] ?? '';
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const NOW = Date.parse('2026-09-12T09:30:00+05:30');
const w = opt('time') ? parseTimeExpression(opt('time')!, NOW) : { after: null, before: null, centre: null, label: null };

const res = await retrieveDictations(query, {
  app: opt('app') ?? null, after: w.after, before: w.before, centre: w.centre ?? null,
}, Number(opt('limit') ?? 8));

console.log(`\nquery "${query}"  window=${w.label ?? '-'}  app=${opt('app') ?? '-'}`);
console.log(`considered ${res.considered}  returned ${res.hits.length}  top ${res.topScore.toFixed(3)}\n`);
res.hits.forEach((h, i) => {
  console.log(`${String(i + 1).padStart(2)}. ${h.id}  ${formatLocal(h.spokenAt)}  ${h.app.padEnd(8)} score=${h.score.toFixed(3)} (lex ${h.lexicalScore.toFixed(2)} vec ${h.vectorScore.toFixed(2)})`);
  console.log(`    ${h.formattedText.replace(/\n/g, ' ').slice(0, 100)}`);
});
console.log('');
