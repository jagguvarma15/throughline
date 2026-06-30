import { useState } from "react";
import { Header } from "./components/Header";
import { MainContent } from "./components/MainContent";
import { Sidebar } from "./components/Sidebar";

export type View = "runs" | "approvals";

export function App() {
  const [view, setView] = useState<View>("runs");
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex h-screen flex-col bg-white text-slate-900">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          view={view}
          onView={(v) => {
            setView(v);
            setSelected(null);
          }}
        />
        <MainContent view={view} selected={selected} onSelect={setSelected} />
      </div>
    </div>
  );
}
