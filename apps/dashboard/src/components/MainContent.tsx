import type { View } from "../App";
import { RunDetail } from "../screens/RunDetail";
import { RunsList } from "../screens/RunsList";

export function MainContent({
  view,
  selected,
  onSelect,
}: {
  view: View;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <main className="min-w-0 flex-1 overflow-auto p-6">
      {selected ? (
        <RunDetail id={selected} onBack={() => onSelect(null)} />
      ) : (
        <RunsList
          status={view === "approvals" ? "waiting" : view === "dead" ? "dead" : undefined}
          onSelect={onSelect}
        />
      )}
    </main>
  );
}
