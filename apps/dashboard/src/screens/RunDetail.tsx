import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Step, cancelRun, getRun, signalRun } from "../api";
import { StatusBadge } from "./RunsList";

function preview(value: unknown): string {
  if (value === undefined) return "—";
  const s = JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

export function RunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["run", id],
    queryFn: () => getRun(id),
    refetchInterval: 1500,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["run", id] });
  const approve = useMutation({
    mutationFn: (ok: boolean) => signalRun(id, data?.run.waitEvent ?? "approve", { approved: ok }),
    onSuccess: invalidate,
  });
  const cancel = useMutation({ mutationFn: () => cancelRun(id), onSuccess: invalidate });

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error || !data) return <p className="text-sm text-red-600">Could not load this run.</p>;
  const { run, steps } = data;
  const active = run.status === "pending" || run.status === "running" || run.status === "waiting";

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 text-sm text-slate-500 hover:text-slate-900"
      >
        ← Back
      </button>

      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-base font-semibold">{run.name}</h2>
        <StatusBadge status={run.status} />
        <span className="font-mono text-xs text-slate-400">{run.id.slice(0, 8)}</span>
      </div>

      {run.status === "waiting" && (
        <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-4">
          <p className="mb-2 text-sm font-medium text-amber-900">
            Awaiting approval{run.waitEvent ? ` (${run.waitEvent})` : ""}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={approve.isPending}
              onClick={() => approve.mutate(true)}
              className="rounded bg-green-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={approve.isPending}
              onClick={() => approve.mutate(false)}
              className="rounded bg-red-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      <h3 className="mb-2 text-sm font-semibold text-slate-700">Timeline (replay checkpoint)</h3>
      <ol className="mb-4 space-y-1">
        {steps.length === 0 && <li className="text-sm text-slate-500">No steps yet.</li>}
        {steps.map((s: Step) => (
          <li
            key={s.stepKey}
            className="flex items-center gap-3 rounded border border-slate-100 px-3 py-2 text-sm"
          >
            <span className="w-6 text-right font-mono text-xs text-slate-400">{s.seq}</span>
            <span className="font-mono text-xs">{s.stepKey}</span>
            <span className="rounded bg-slate-100 px-1.5 text-xs text-slate-500">{s.kind}</span>
            <StatusBadge status={s.status} />
            {s.attempts > 1 && <span className="text-xs text-amber-600">×{s.attempts}</span>}
            <span className="ml-auto truncate font-mono text-xs text-slate-500">
              {preview(s.output)}
            </span>
          </li>
        ))}
      </ol>

      {run.output !== undefined && run.output !== null && (
        <div className="mb-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-700">Output</h3>
          <pre className="overflow-auto rounded bg-slate-50 p-3 text-xs">
            {JSON.stringify(run.output, null, 2)}
          </pre>
        </div>
      )}

      {active && (
        <button
          type="button"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
          className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Cancel run
        </button>
      )}
    </div>
  );
}
