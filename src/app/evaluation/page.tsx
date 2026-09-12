'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Note, Section, Stat } from '@/components/ui';

export default function EvalPage() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/eval').then((r) => r.json()).then((j) => (j.error ? setErr(j.error) : setD(j)));
  }, []);

  if (err) return (
    <div>
      <h1 className="mb-3 text-[22px] font-semibold tracking-tight">Evaluation</h1>
      <Note tone="warn">{err}</Note>
    </div>
  );
  if (!d) return <p className="text-[13px] text-muted">loading…</p>;

  const cats = Object.entries(d.summary.byCategory) as [string, any][];
  const failed = d.results.filter((r: any) => !r.passed);

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Evaluation</h1>
        <span className="text-[12.5px] text-muted">{d.suite} · run {d.runId}</span>
      </div>
      <p className="mb-5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
        Run with <code className="font-mono text-[12px]">npm run eval</code>. Every case runs the real
        pipeline against the ingested corpus. Failures are listed, not hidden.
      </p>

      {!d.valid && <div className="mb-4"><Note tone="warn">This run used the offline stub. It checks plumbing, not the product.</Note></div>}

      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="passed" value={`${d.summary.passed}/${d.summary.total}`} />
        <Stat label="latency p50" value={`${d.latencyMs.p50}ms`} sub={`p95 ${d.latencyMs.p95}ms`} />
        <Stat label="cost" value={`$${d.costUsd.toFixed(4)}`} sub="this run" />
        <Stat label="memory" value={d.memoryState.active_entities} sub="confirmed facts" />
        <Stat label="left alone" value={d.memoryState.ignored} sub="with reasons" />
      </div>

      <Section title="By category">
        <div className="space-y-1.5">
          {cats.map(([c, v]) => (
            <div key={c} className="card flex items-center gap-3 px-3 py-2">
              <span className="w-40 text-[13px]">{c.replace(/_/g, ' ')}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-sand">
                <div className={`h-full ${v.pass === v.total ? 'bg-good' : 'bg-warn'}`} style={{ width: `${(v.pass / v.total) * 100}%` }} />
              </div>
              <span className="w-12 text-right font-mono text-[12px] tabular-nums">{v.pass}/{v.total}</span>
            </div>
          ))}
        </div>
      </Section>

      {failed.length > 0 && (
        <Section title="Failures" hint="left visible on purpose">
          <div className="space-y-2">
            {failed.map((r: any) => (
              <div key={r.caseId} className="card border-warn/40 bg-warn/[0.03] p-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11.5px] text-warn">{r.caseId}</span>
                  <span className="text-[11.5px] text-muted">{r.category}</span>
                </div>
                {r.question && <p className="mt-1 text-[13px]">{r.question}</p>}
                <p className="mt-1 text-[12.5px] text-warn">{r.detail}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="All cases">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="text-[10.5px] uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="py-1.5 text-left font-medium">case</th>
                <th className="text-left font-medium">category</th>
                <th className="text-left font-medium">question / assertion</th>
                <th className="text-right font-medium">latency</th>
                <th className="text-right font-medium">result</th>
              </tr>
            </thead>
            <tbody>
              {d.results.map((r: any) => (
                <tr key={r.caseId} className="border-b border-edge/50 last:border-0">
                  <td className="py-1.5 font-mono text-[11px]">{r.caseId}</td>
                  <td className="text-muted">{r.category.replace(/_/g, ' ')}</td>
                  <td className="max-w-md truncate">{r.question ?? r.detail}</td>
                  <td className="text-right tabular-nums text-muted">{r.latencyMs}ms</td>
                  <td className={`text-right font-medium ${r.passed ? 'text-good' : 'text-warn'}`}>{r.passed ? 'pass' : 'fail'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <p className="text-[12px] text-muted">
        Full report: <code className="font-mono">eval/results/latest.json</code> and{' '}
        <code className="font-mono">eval/results/latest.md</code>. Memory state is browsable under{' '}
        <Link href="/memory" className="text-accent underline underline-offset-2">Memory</Link>.
      </p>
    </div>
  );
}
