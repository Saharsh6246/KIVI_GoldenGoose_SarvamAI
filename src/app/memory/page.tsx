'use client';
import { useEffect, useState } from 'react';
import { Note, Section, Disclosure, Stat, fmt } from '@/components/ui';

type Tab = 'facts' | 'preferences' | 'episodes' | 'ignored' | 'events';

export default function MemoryPage() {
  const [tab, setTab] = useState<Tab>('facts');
  const [data, setData] = useState<any>(null);
  const [dicts, setDicts] = useState<any>(null);
  const [q, setQ] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<any>(null);

  async function load() {
    const [m, d] = await Promise.all([
      fetch('/api/memory').then((r) => r.json()),
      fetch(`/api/dictations?limit=60&q=${encodeURIComponent(q)}`).then((r) => r.json()),
    ]);
    setData(m); setDicts(d);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setTimeout(() => { fetch(`/api/dictations?limit=60&q=${encodeURIComponent(q)}`).then((r) => r.json()).then(setDicts); }, 220); return () => clearTimeout(t); }, [q]);

  async function decide(preferenceId: string, decision: string) {
    await fetch('/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preferenceId, decision }) });
    load();
  }
  async function forget(idv: string) {
    setDeleting(idv);
    const r = await fetch(`/api/dictations?id=${idv}`, { method: 'DELETE' });
    setDeleted(await r.json());
    setDeleting(null);
    load();
  }

  if (!data) return <p className="text-[13px] text-muted">loading…</p>;

  const active = data.entities.filter((e: any) => e.status === 'active');
  const candidates = data.entities.filter((e: any) => e.status !== 'active');
  const proposed = data.preferences.filter((p: any) => p.status === 'proposed' && p.evidenceCount >= 3);
  const otherPrefs = data.preferences.filter((p: any) => !(p.status === 'proposed' && p.evidenceCount >= 3));

  const TABS: [Tab, string, number][] = [
    ['facts', 'What Kivi knows', active.length],
    ['preferences', 'How you write', proposed.length + otherPrefs.length],
    ['episodes', 'Everything you said', data.stats.dictations],
    ['ignored', 'What it left alone', data.stats.ignored],
    ['events', 'Audit', data.stats.events],
  ];

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Memory</h1>
        <span className="text-[12.5px] text-muted">everything here points at something you said</span>
      </div>

      <div className="mb-6 mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="dictations" value={data.stats.dictations} />
        <Stat label="facts" value={active.length} sub={`${candidates.length} unconfirmed`} />
        <Stat label="preferences" value={data.preferences.length} />
        <Stat label="left alone" value={data.stats.ignored} />
        <Stat label="database" value={`${(data.stats.dbBytes / 1024 / 1024).toFixed(1)} MB`} />
      </div>

      <div className="mb-5 flex flex-wrap gap-1 border-b border-edge">
        {TABS.map(([t, label, n]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition ${tab === t ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'}`}>
            {label} <span className="ml-1 font-mono text-[11px] text-muted/70">{n}</span>
          </button>
        ))}
      </div>

      {deleted && (
        <div className="mb-4">
          <Note tone="good">
            Deleted <span className="font-mono">{deleted.deleted}</span>. With it went {deleted.alsoRemoved.mentions} mention(s),{' '}
            {deleted.alsoRemoved.facts} fact(s) and {deleted.alsoRemoved.preferenceEvidence} piece(s) of preference evidence.
            {deleted.alsoRemoved.entitiesRemoved.length > 0 && <> Kivi no longer knows: <b>{deleted.alsoRemoved.entitiesRemoved.join(', ')}</b>.</>}
            {deleted.alsoRemoved.entitiesDemoted.length > 0 && <> Demoted back to unconfirmed: <b>{deleted.alsoRemoved.entitiesDemoted.join(', ')}</b>.</>}
          </Note>
        </div>
      )}

      {tab === 'facts' && (
        <>
          <Section title="Confirmed" hint="heard in at least two separate dictations">
            <div className="space-y-2">
              {active.map((e: any) => (
                <div key={e.id} className="card p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[14.5px] font-medium">{e.canonicalName}</span>
                    <span className="rounded bg-sand px-1.5 py-[1px] text-[10.5px] uppercase tracking-wide text-muted">{e.kind}</span>
                    {e.aliases.length > 0 && <span className="text-[11.5px] text-muted">also: {e.aliases.join(', ')}</span>}
                    <span className="ml-auto font-mono text-[11px] text-muted">{e.distinctDictations} dictations</span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-muted">{e.reason}</p>
                  {e.facts.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {e.facts.map((f: any) => (
                        <li key={f.id} className="text-[13px]">
                          • {f.claim}{' '}
                          <span className="font-mono text-[10.5px] text-accent">{f.dictationId}</span>
                          {f.state !== 'current' && <span className="ml-1 text-[11px] text-warn">superseded</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2">
                    <Disclosure label="where this came from" count={e.mentions.length}>
                      <ul className="space-y-1.5">
                        {e.mentions.map((m: any) => (
                          <li key={m.id} className="rounded bg-sand/50 px-2.5 py-1.5 text-[12px] leading-relaxed">
                            <span className="font-mono text-[10.5px] text-accent">{m.dictationId}</span>
                            <span className="ml-2 text-muted">{fmt(m.spokenAt)}</span>
                            <div className="text-muted">“{m.snippet}”</div>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  </div>
                </div>
              ))}
              {active.length === 0 && <Note>Nothing confirmed yet. Run the ingest command.</Note>}
            </div>
          </Section>

          <Section title="Not confirmed" hint="heard once — Kivi is holding these, not believing them">
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((e: any) => (
                <span key={e.id} className="chip" title={e.reason ?? ''}>{e.canonicalName}</span>
              ))}
              {candidates.length === 0 && <span className="text-[12.5px] text-muted">none</span>}
            </div>
          </Section>
        </>
      )}

      {tab === 'preferences' && (
        <>
          <Section title="Waiting for you" hint="Kivi proposes; it never adopts a preference on its own">
            <div className="space-y-2">
              {proposed.map((p: any) => (
                <div key={p.id} className="card p-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[14px] font-medium">{p.statement}</span>
                    <span className="text-[11.5px] text-muted">{p.scopeType === 'global' ? 'everywhere' : `in ${p.scopeValue}`}</span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-muted">{p.reason}</p>
                  <Disclosure label="you said this" count={p.evidence.length}>
                    <ul className="space-y-1">
                      {p.evidence.map((ev: any) => (
                        <li key={ev.id} className="rounded bg-sand/50 px-2.5 py-1.5 text-[12px] text-muted">
                          <span className="font-mono text-[10.5px] text-accent">{ev.dictationId}</span> {fmt(ev.spokenAt)} — “{ev.snippet}”
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                  <div className="mt-2.5 flex gap-2">
                    <button onClick={() => decide(p.id, 'active')} className="rounded-md bg-ink px-3 py-1 text-[12.5px] text-paper">Yes, do that</button>
                    <button onClick={() => decide(p.id, 'dismissed')} className="rounded-md border border-edge px-3 py-1 text-[12.5px] text-muted hover:text-ink">No</button>
                  </div>
                </div>
              ))}
              {proposed.length === 0 && <Note>Nothing to decide. Kivi waits for three separate instances before it asks.</Note>}
            </div>
          </Section>

          <Section title="Everything else">
            <div className="space-y-1.5">
              {otherPrefs.map((p: any) => (
                <div key={p.id} className="card flex items-center gap-2 px-3 py-2 text-[13px]">
                  <span>{p.statement}</span>
                  <span className="text-[11.5px] text-muted">{p.scopeType === 'global' ? 'everywhere' : p.scopeValue}</span>
                  <span className={`ml-auto rounded px-1.5 py-[1px] text-[10.5px] uppercase tracking-wide ${
                    p.status === 'active' ? 'bg-good/10 text-good' : p.status === 'dismissed' ? 'bg-sand text-muted' : 'bg-warn/10 text-warn'}`}>
                    {p.status === 'proposed' ? `${p.evidenceCount}/3 evidence` : p.status}
                  </span>
                  {p.status === 'active' && (
                    <button onClick={() => decide(p.id, 'dismissed')} className="text-[11.5px] text-muted underline underline-offset-2 hover:text-ink">stop</button>
                  )}
                </div>
              ))}
            </div>
          </Section>
        </>
      )}

      {tab === 'episodes' && (
        <Section title="Everything you said" hint="the source of truth — delete one and what it taught goes with it">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search your dictations…"
            className="mb-3 w-full rounded border border-edge bg-white px-3 py-2 text-[13px]" />
          <div className="space-y-1.5">
            {dicts?.rows?.map((d: any) => (
              <div key={d.id} className="card px-3 py-2.5">
                <div className="flex flex-wrap items-baseline gap-2 text-[11.5px] text-muted">
                  <span className="font-mono text-[10.5px] text-accent">{d.id}</span>
                  <span>{d.app}</span>
                  <span>{fmt(d.spokenAt)}</span>
                  {d.recipient && <span>to {d.recipient}</span>}
                  {d.windowTitle && <span>{d.windowTitle}</span>}
                  <button onClick={() => forget(d.id)} disabled={deleting === d.id}
                    className="ml-auto text-[11.5px] text-muted underline underline-offset-2 hover:text-accent">
                    {deleting === d.id ? 'forgetting…' : 'forget this'}
                  </button>
                </div>
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed">{d.formattedText}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {tab === 'ignored' && (
        <Section title="What Kivi deliberately left alone" hint="refusing to learn is a decision, so it is logged like any other">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {data.ignoreSummary.map((s: any) => (
              <span key={s.reason} className="chip">{s.reason.replace(/_/g, ' ')} <b className="text-ink">{s.n}</b></span>
            ))}
          </div>
          <div className="space-y-1.5">
            {data.ignored.slice(0, 120).map((r: any) => (
              <div key={r.id} className="card px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-2 text-[11.5px]">
                  <span className="rounded bg-sand px-1.5 py-[1px] uppercase tracking-wide text-muted">{r.reason.replace(/_/g, ' ')}</span>
                  <span className="font-mono text-[10.5px] text-accent">{r.dictationId}</span>
                  <span className="text-muted">at {r.stage}</span>
                </div>
                <p className="mt-1 text-[12.5px]">{r.candidate}</p>
                {r.detail && <p className="text-[11.5px] text-muted">{r.detail}</p>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {tab === 'events' && (
        <Section title="Audit" hint="every create, reinforce, promote and reject, in order">
          <div className="space-y-1">
            {data.events.map((e: any) => (
              <div key={e.id} className="card flex flex-wrap items-baseline gap-2 px-3 py-1.5 text-[12px]">
                <span className={`rounded px-1.5 py-[1px] text-[10.5px] uppercase tracking-wide ${
                  e.action === 'promoted' ? 'bg-good/10 text-good' : e.action === 'rejected' || e.action === 'deleted' ? 'bg-warn/10 text-warn' : 'bg-sand text-muted'}`}>
                  {e.action}
                </span>
                <span className="font-medium">{e.targetLabel}</span>
                <span className="text-muted">{e.reason}</span>
                {e.sourceDictationId && <span className="ml-auto font-mono text-[10.5px] text-accent">{e.sourceDictationId}</span>}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
