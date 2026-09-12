'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Note, Section, Disclosure } from '@/components/ui';

const SAMPLES: Record<string, string> = {
  Slack: 'um so priya i think the meridien backfill is going to uh spill into next week the retries are double counted so the numbers look worse than they are',
  Mail: 'okay so sandra just confirming that the meridien go live is the twenty first of october we will freeze changes the week before thanks ananya',
  Cursor: 'refactor the retry handler so backoff is configurable per endpoint keep the existing default of three attempts',
  Linear: 'split this ticket the migration and the backfill are different risks and should ship separately',
  Notion: 'design note for tollgate options considered dual write change data capture and a scheduled reconcile going with change data capture',
  Notes: 'remember to ask karthik about the rollback plan before friday',
};

export default function DictatePage() {
  const [app, setApp] = useState('Slack');
  const [raw, setRaw] = useState(SAMPLES.Slack);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any>(null);

  async function send() {
    setBusy(true); setOut(null);
    const r = await fetch('/api/dictate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw, app }),
    });
    const j = await r.json();
    setOut(j);
    setBusy(false);
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Dictate</h1>
        <span className="text-[12.5px] text-muted">ordinary use — you speak, Kivi writes</span>
      </div>
      <p className="mb-6 max-w-2xl text-[13.5px] leading-relaxed text-muted">
        Speech recognition is not part of this build, so paste or edit a transcript and press the key.
        Everything else is real.
      </p>

      <div className="card mb-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-edge bg-sand/40 px-3 py-2">
          <span className="text-[11px] uppercase tracking-wide text-muted">dictating into</span>
          <select
            value={app}
            onChange={(e) => { setApp(e.target.value); setRaw(SAMPLES[e.target.value] ?? ''); setOut(null); }}
            className="rounded border border-edge bg-white px-2 py-1 text-[12.5px]"
          >
            {Object.keys(SAMPLES).map((a) => <option key={a}>{a}</option>)}
          </select>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
            <span className={`inline-block h-1.5 w-1.5 rounded-full bg-accent ${busy ? 'listening' : ''}`} />
            hold <span className="kbd">fn</span> to talk
          </span>
        </div>
        <textarea
          value={raw} onChange={(e) => setRaw(e.target.value)} rows={4}
          className="w-full resize-none bg-transparent px-3 py-3 font-mono text-[12.5px] leading-relaxed text-muted"
          placeholder="raw speech, as the recogniser heard it…"
        />
        <div className="flex items-center gap-2 border-t border-edge px-3 py-2">
          <button onClick={send} disabled={busy || !raw.trim()}
            className="rounded-md bg-ink px-3.5 py-1.5 text-[13px] text-paper disabled:opacity-40">
            {busy ? 'writing…' : 'Release key'}
          </button>
          <span className="text-[11.5px] text-muted">Kivi types the result into {app}.</span>
        </div>
      </div>

      {out?.formatted && (
        <Section title="What Kivi typed">
          <div className="card p-4">
            <p className="whitespace-pre-wrap text-[14.5px] leading-[1.65]">{out.formatted}</p>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="card px-3 py-2.5">
              <div className="text-[11px] uppercase tracking-wide text-muted">what shaped this</div>
              <ul className="mt-1.5 space-y-1 text-[12.5px]">
                <li>• <b>Style for {app}</b> — {out.styleInstruction}</li>
                <li>• <b>Phonetic memory</b> — {out.appliedPhonetic?.length
                  ? out.appliedPhonetic.map((p: any) => `${p.heard} → ${p.written}`).join(', ')
                  : 'nothing to correct in this one'}</li>
              </ul>
            </div>
            <div className="card border-good/30 bg-good/[0.04] px-3 py-2.5">
              <div className="text-[11px] uppercase tracking-wide text-good">semantic memory: not used</div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
                Kivi knows a great deal about this person&apos;s work, and deliberately used none of it here.
                Dictation is a motor act: there is no moment to explain an intervention, so a change driven
                by memory would be indistinguishable from a mis-hearing.{' '}
                <Link href="/ask" className="text-accent underline underline-offset-2">Memory speaks only when spoken to.</Link>
              </p>
            </div>
          </div>
          <div className="mt-3">
            <Disclosure label="engineering detail">
              <div className="card px-3 py-2 font-mono text-[11.5px] text-muted">
                <div>dictation_id      {out.id}</div>
                <div>model             {out.model}</div>
                <div>latency           {out.latencyMs}ms</div>
                <div>cost              ${Number(out.costUsd ?? 0).toFixed(6)}</div>
                <div>memory_retrieval  not performed (dictation path)</div>
              </div>
            </Disclosure>
          </div>
          <div className="mt-4">
            <Note>
              This dictation is now part of the record. It will be searchable from Hey Kivi, and anything it
              teaches Kivi will point back at it. Run the ingest command to extract from it.
            </Note>
          </div>
        </Section>
      )}
    </div>
  );
}
