export function Header() {
  return (
    <header className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Throughline</h1>
        <p className="text-xs text-slate-500">Durable runs</p>
      </div>
      <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">v0.1</span>
    </header>
  );
}
