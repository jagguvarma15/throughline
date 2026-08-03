import type { View } from "../App";

const ITEMS: Array<{ id: View; label: string }> = [
  { id: "runs", label: "Runs" },
  { id: "approvals", label: "Approvals" },
  { id: "dead", label: "Dead letter" },
];

export function Sidebar({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <nav className="w-48 shrink-0 border-r border-slate-200 p-3">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onView(item.id)}
          className={`mb-1 block w-full rounded px-3 py-2 text-left text-sm ${
            view === item.id ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
