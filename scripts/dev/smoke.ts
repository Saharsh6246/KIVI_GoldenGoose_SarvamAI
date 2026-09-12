import 'dotenv/config';
import { ask } from '../../src/lib/heykivi/agent';
const NOW = Date.parse('2026-09-12T09:30:00+05:30');
const qs = process.argv.slice(2).length ? process.argv.slice(2) : [
  'find the dictation I did around 5 PM yesterday in Slack',
  'when does Meridian go live?',
  'who is my contact at Fernway?',
  "what is Priya's phone number?",
];
for (const q of qs) {
  const r = await ask({ query: q, now: NOW, app: 'Slack' });
  console.log('\nQ:', q);
  console.log('A:', r.answer.slice(0, 320));
  console.log(`   refused=${r.refused} top=${r.topScore.toFixed(2)} cites=${r.citations.length} retrieval=${r.retrievalMs}ms tools=${r.toolCalls.map(t=>t.name).join(',')}`);
  if (r.refusalReason) console.log('   why:', r.refusalReason);
}
