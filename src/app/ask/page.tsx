'use client';
import { useEffect, useState } from 'react';
import { Note, Section, Disclosure, fmt } from '@/components/ui';

const EXAMPLES = [
  'Find the dictation I did around 5 PM yesterday in Slack and polish it for the meeting I\'m walking into.',
  'When does Meridian go live?',
  'Who is my contact at Fernway?',
  'What command do I use to deploy ledger-svc to staging?',
  "What is Priya's phone number?",
  'What did I say about the Zurich office?',
];

type Trace = { kind: string; refId: string; label: string; rank: number; lexicalScore: number; vectorScore: number; score: number; note?: string };
type Result = {
  interactionId: string; answer: string; refused: boolean; refusalReason: string | null;
  citations: string[]; trace: Trace[]; toolCalls: { name: string; args: any }[];
  topScore: number; retrievalMs: number; totalMs: number; tokensIn: number; tokensOut: number; costUsd: number; model: string;
};

export default function AskPage() {
  const [q, setQ] = useState('');
  const [app, setApp] = useState('Slack');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, any>>({});

  async function run(query = q) {
    if (!query.trim()) return;
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await fetch('/api/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, app }),
      });
      const j = await r.json();
      if (j.error) setErr(j.error); else setRes(j);
    } catch (e: any) { setErr(e?.message ?? 'failed'); }
    setBusy(false);
  }

  async function loadDictation(idv: string) {
    if (open[idv]) { setOpen((o) => ({ ...o, [idv]: null })); return; }
    const r = await fetch(`/api/dictations?id=${idv}`);
    const j = await r.json();
    setOpen((o) => ({ ...o, [idv]: j }));
  }

  const rendered = res ? renderAnswer(res.answer, res.citations) : null;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h1 className="text-[22px] font-semibold tracking-tight">Hey Kivi</h1>
        <span className="text-[12.5px] text-muted">— this is the only place memory is allowed to speak</span>
      </div>

      <div className="card mb-4 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted">from</span>
          <select value={app} onChange={(e) => setApp(e.target.value)} className="rounded border border-edge bg-white px-2 py-1 text-[12.5px]">
            {['Slack', 'Mail', 'Linear', 'Cursor', 'Notion', 'Notes'].map((a) => <option key={a}>{a}</option>)}
          </select>
          <span className="ml-auto text-[11px] text-muted">clock pinned to 12 Sep 2026, 09:30 IST</span>
        </div>
        <textarea
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); }}
          rows={2} placeholder="Ask about something you said…"
          className="w-full resize-none rounded border border-edge bg-white px-3 py-2 text-[14px] leading-relaxed"
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={() => run()} disabled={busy || !q.trim()}
            className="rounded-md bg-ink px-3.5 py-1.5 text-[13px] text-paper transition disabled:opacity-40">
            {busy ? 'thinking…' : 'Ask'}
          </button>
          <span className="text-[11px] text-muted">⌘↵</span>
        </div>
      </div>

      <div className="mb-8 flex flex-wrap gap-1.5">
        {EXAMPLES.map((e) => (
          <button key={e} onClick={() => { setQ(e); run(e); }}
            className="rounded-full border border-edge bg-white/60 px-2.5 py-1 text-left text-[11.5px] text-muted transition hover:border-accent hover:text-accent">
            {e.length > 62 ? e.slice(0, 60) + '…' : e}
          </button>
        ))}
      </div>

      {err && <Note tone="warn">{err}</Note>}

      {res && (
        <>
          <Section title={res.refused ? 'Kivi declined' : 'Answer'}>
            <div className={`card p-4 ${res.refused ? 'border-warn/40 bg-warn/[0.03]' : ''}`}>
              <div className="whitespace-pre-wrap text-[14.5px] leading-[1.65]">{rendered}</div>
              {res.refused && res.refusalReason && (
                <p className="mt-3 border-t border-edge pt-2 text-[12px] text-warn">Why: {res.refusalReason}</p>
              )}
            </div>
            <p className="mt-2 text-[11.5px] text-muted">
              {res.citations.length > 0
                ? 'Every claim above points at a dictation. Click a citation to read it.'
                : 'No citation means nothing was asserted.'}
            </p>
          </Section>

          {res.citations.length > 0 && (
            <Section title="Sources" hint="the dictations this answer came from">
              <div className="space-y-2">
                {res.citations.map((c) => (
                  <div key={c} className="card overflow-hidden">
                    <button onClick={() => loadDictation(c)} className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-sand/40">
                      <span className="font-mono text-[11px] text-accent">{c}</span>
                      <span className="text-[12px] text-muted">
                        {res.trace.find((t) => t.refId === c)?.label ?? ''}
                      </span>
                      <span className="ml-auto text-[11px] text-muted">{open[c] ? 'hide' : 'read it'}</span>
                    </button>
                    {open[c] && (
                      <div className="border-t border-edge bg-white/40 px-3 py-3">
                        <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-muted">
                          <span>{open[c].app}</span>
                          <span>{fmt(open[c].spokenAt)}</span>
                          {open[c].recipient && <span>to {open[c].recipient}</span>}
                          {open[c].windowTitle && <span>{open[c].windowTitle}</span>}
                        </div>
                        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{open[c].formattedText}</p>
                        <Disclosure label="raw speech">
                          <p className="rounded bg-sand/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-muted">{open[c].rawAsr}</p>
                        </Disclosure>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Why this answer" hint="everything retrieval put on the table, used or not">
            <div className="card p-3">
              <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] text-muted">
                <span>tools: <b className="text-ink">{res.toolCalls.map((t) => t.name).join(' → ') || 'none'}</b></span>
                <span>retrieval <b className="text-ink">{res.retrievalMs}ms</b></span>
                <span>total <b className="text-ink">{res.totalMs}ms</b></span>
                <span>best score <b className="text-ink">{res.topScore.toFixed(2)}</b></span>
                <span>{res.tokensIn}+{res.tokensOut} tokens</span>
                <span>${res.costUsd.toFixed(5)}</span>
                <span className="font-mono">{res.model}</span>
              </div>
              <table className="w-full text-[12px]">
                <thead className="text-[10.5px] uppercase tracking-wide text-muted">
                  <tr className="border-b border-edge">
                    <th className="py-1 text-left font-medium">candidate</th>
                    <th className="text-left font-medium">kind</th>
                    <th className="text-right font-medium">lexical</th>
                    <th className="text-right font-medium">vector</th>
                    <th className="text-right font-medium">score</th>
                    <th className="text-right font-medium">used</th>
                  </tr>
                </thead>
                <tbody>
                  {res.trace.map((t, i) => {
                    const used = res.citations.includes(t.refId) || t.kind !== 'dictation';
                    return (
                      <tr key={i} className="border-b border-edge/50 last:border-0">
                        <td className="py-1.5">
                          <span className="font-mono text-[11px]">{t.refId}</span>
                          <span className="ml-2 text-muted">{t.label}</span>
                          {t.note && <div className="text-[11px] text-muted/80">{t.note}</div>}
                        </td>
                        <td className="text-muted">{t.kind}</td>
                        <td className="text-right tabular-nums text-muted">{t.lexicalScore.toFixed(2)}</td>
                        <td className="text-right tabular-nums text-muted">{t.vectorScore.toFixed(2)}</td>
                        <td className="text-right tabular-nums font-medium">{t.score.toFixed(2)}</td>
                        <td className={`text-right ${used ? 'text-good' : 'text-muted/60'}`}>{used ? 'yes' : 'no'}</td>
                      </tr>
                    );
                  })}
                  {res.trace.length === 0 && <tr><td colSpan={6} className="py-3 text-center text-muted">Retrieval returned nothing.</td></tr>}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-muted">interaction <span className="font-mono">{res.interactionId}</span></p>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

/** Renders [d_xxx] citations as clickable chips inline. */
function renderAnswer(text: string, citations: string[]) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  const re = /\[([a-z]_[a-z0-9]{4,})\]/g;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index));
    const valid = citations.includes(m[1]);
    parts.push(
      <sup key={k++} className={`mx-0.5 rounded px-1 py-[1px] font-mono text-[10px] ${valid ? 'bg-accent/10 text-accent' : 'bg-warn/10 text-warn line-through'}`}>
        {m[1]}
      </sup>
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}
