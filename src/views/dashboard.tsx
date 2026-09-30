/** Read-only operations dashboard shell (the "Filament" screen). All data loads via /api. */
export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Instructor Revenue Ledger</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2310b981'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-size='18' font-family='sans-serif' font-weight='700' fill='%230f172a'%3E%C2%A2%3C/text%3E%3C/svg%3E" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
  <link href="/static/style.css" rel="stylesheet" />
  <script>
    tailwind.config = { theme: { extend: { fontFamily: { mono: ['ui-monospace','SFMono-Regular','Menlo','monospace'] } } } }
  </script>
</head>
<body class="h-full bg-slate-50 text-slate-800">
  <div class="min-h-full flex">
    <aside id="sidebar" class="w-60 shrink-0 bg-slate-900 text-slate-200 flex flex-col">
      <header class="px-5 py-5 border-b border-slate-800">
        <a href="/" data-link class="flex items-center gap-3">
          <span class="w-9 h-9 rounded-lg bg-emerald-500 grid place-items-center text-slate-900"><i class="fas fa-scale-balanced"></i></span>
          <span>
            <span class="block font-semibold leading-tight">Revenue Ledger</span>
            <span class="block text-xs text-slate-400">Instructor payouts</span>
          </span>
        </a>
      </header>
      <nav id="main-nav" class="flex-1 px-3 py-4 space-y-1 text-sm">
        <a href="/#/overview" data-nav="overview" class="nav-item"><i class="fas fa-gauge-high w-5"></i>Overview</a>
        <a href="/#/instructors" data-nav="instructors" class="nav-item"><i class="fas fa-user-tie w-5"></i>Instructor balances</a>
        <a href="/#/payouts" data-nav="payouts" class="nav-item"><i class="fas fa-money-bill-transfer w-5"></i>Payout history</a>
        <a href="/#/payments" data-nav="payments" class="nav-item"><i class="fas fa-receipt w-5"></i>Subscriptions</a>
        <a href="/#/events" data-nav="events" class="nav-item"><i class="fas fa-list-check w-5"></i>Audit log</a>
        <a href="/#/ops" data-nav="ops" class="nav-item"><i class="fas fa-terminal w-5"></i>Ops console</a>
      </nav>
      <footer class="px-5 py-4 text-xs text-slate-500 border-t border-slate-800">
        <div id="clock-badge" class="flex items-center gap-2"><i class="fas fa-clock"></i><span>—</span></div>
        <div id="provider-badge" class="flex items-center gap-2 mt-1"><i class="fas fa-plug"></i><span>—</span></div>
      </footer>
    </aside>

    <main class="flex-1 min-w-0">
      <header class="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between">
        <h1 id="page-title" class="text-lg font-semibold">Overview</h1>
        <div class="flex items-center gap-3 text-sm">
          <span class="text-slate-500 hidden md:inline"><i class="fas fa-eye mr-1"></i>Read-only ledger view</span>
          <button id="refresh-btn" class="btn-secondary"><i class="fas fa-rotate"></i> Refresh</button>
        </div>
      </header>
      <section id="view" class="p-8"></section>
    </main>
  </div>

  <div id="toast" class="fixed bottom-6 right-6 hidden max-w-md"></div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/relativeTime.js"></script>
  <script>dayjs.extend(window.dayjs_plugin_relativeTime)</script>
  <script src="/static/app.js"></script>
</body>
</html>`
}
