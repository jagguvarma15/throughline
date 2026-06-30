import { useQuery } from "@tanstack/react-query";
import { type Run, listRuns } from "../api";

const STATUS_COLOR: Record<string, string> = {
  completed: "bg-green-100 text-green-800",
  running: "bg-blue-100 text-blue-800",
  waiting: "bg-amber-100 text-amber-800",
  dead: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-slate-200 text-slate-700",
  pending: "bg-slate-100 text-slate-600",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status] ?? "bg-slate-100"}`}
    >
      {status}
    </span>
  );
}

export function RunsList({
  status,
  onSelect,
}: { status?: string; onSelect: (id: string) => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["runs", status ?? "all"],
    queryFn: () => listRuns(status),
    refetchInterval: 2000,
  });

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="text-sm text-red-600">Could not reach the control-plane API.</p>;

  const runs = data ?? [];
  return (
    <div>
      <h2 className="mb-4 text-base font-semibold">
        {status === "waiting" ? "Pending approvals" : "Runs"}
      </h2>
      {runs.length === 0 ? (
        <p className="text-sm text-slate-500">No runs.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-2 font-medium">Run</th>
              <th className="font-medium">Task</th>
              <th className="font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run: Run) => (
              <tr
                key={run.id}
                onClick={() => onSelect(run.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(run.id);
                }}
                tabIndex={0}
                className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="py-2 font-mono text-xs">{run.id.slice(0, 8)}</td>
                <td>{run.name}</td>
                <td>
                  <StatusBadge status={run.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
