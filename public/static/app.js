/* Instructor Revenue Ledger - read-only dashboard + ops console (vanilla JS, hash router) */
(function () {
  'use strict'

  const api = axios.create({ baseURL: '/api' })
  const $view = document.getElementById('view')
  const $title = document.getElementById('page-title')
  const $toast = document.getElementById('toast')

  // ------------------------------------------------------------------ helpers
  const money = (minor, cur = 'USD') => {
    if (minor === null || minor === undefined) return '—'
    const n = Number(minor)
    const sign = n < 0 ? '-' : ''
    const abs = Math.abs(n)
    return `${sign}${cur === 'USD' ? '$' : cur + ' '}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const badge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`
  const when = (iso) => (iso ? `<span title="${esc(iso)}">${dayjs(iso).format('YYYY-MM-DD HH:mm')}</span>` : '—')
  const short = (s, n = 18) => (s && s.length > n ? `<span class="mono" title="${esc(s)}">${esc(s.slice(0, n))}…</span>` : `<span class="mono">${esc(s ?? '—')}</span>`)
  const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0)

  let toastTimer
  function toast(msg, opts = {}) {
    clearTimeout(toastTimer)
    $toast.innerHTML = `<div class="toast ${opts.error ? 'error' : ''}"><div><i class="fas ${opts.error ? 'fa-triangle-exclamation' : 'fa-circle-check'} mr-2"></i>${esc(msg)}</div>${opts.detail ? `<pre>${esc(typeof opts.detail === 'string' ? opts.detail : JSON.stringify(opts.detail, null, 2))}</pre>` : ''}</div>`
    $toast.classList.remove('hidden')
    toastTimer = setTimeout(() => $toast.classList.add('hidden'), opts.detail ? 12000 : 4000)
  }

  async function post(url, body) {
    try {
      const { data } = await api.post(url, body ?? {})
      return data
    } catch (e) {
      const msg = e.response?.data?.error || e.message
      toast(msg, { error: true })
      throw e
    }
  }

  async function refreshBadges() {
    try {
      const { data } = await api.get('/summary')
      document.querySelector('#clock-badge span').textContent = (data.frozenNow ? 'Frozen: ' : 'Now: ') + dayjs(data.now).format('YYYY-MM-DD HH:mm') + ' UTC'
      document.querySelector('#provider-badge span').textContent = 'Provider: ' + data.providerScenario
      return data
    } catch { return null }
  }

  // ------------------------------------------------------------------ views
  const views = {}

  views.overview = async () => {
    $title.textContent = 'Overview'
    const [{ data: s }, { data: integ }, { data: pays }] = await Promise.all([api.get('/summary'), api.get('/integrity'), api.get('/payouts?limit=8')])
    const byStatus = Object.fromEntries((s.payoutsByStatus || []).map((r) => [r.status, r]))
    const st = (k) => byStatus[k] || { n: 0, amount: 0 }
    const b = s.balances
    const empty = (s.payments?.n ?? 0) === 0

    $view.innerHTML = `
      ${empty ? `<div class="card mb-6"><div class="card-body flex items-center justify-between gap-6">
          <div><div class="font-semibold"><i class="fas fa-seedling text-emerald-500 mr-2"></i>Ledger is empty</div>
          <div class="text-sm text-slate-500 mt-1">Load the demo dataset (4 instructors, 6 prepaid subscriptions spread over the last 200 days) to explore balances, recognition and payouts.</div></div>
          <button class="btn-primary" data-action="seed"><i class="fas fa-database"></i> Seed demo data</button></div></div>` : ''}

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div class="stat"><div class="stat-label">Earned (recognized)</div><div class="stat-value">${money(b.earned)}</div><div class="stat-sub">${b.instructors} instructor balance rows</div></div>
        <div class="stat"><div class="stat-label">Available to pay</div><div class="stat-value text-emerald-600">${money(b.available)}</div><div class="stat-sub">earned − paid − reserved</div></div>
        <div class="stat"><div class="stat-label">Reserved</div><div class="stat-value text-amber-600">${money(b.reserved)}</div><div class="stat-sub">${s.activePayouts} active payout intent(s)</div></div>
        <div class="stat"><div class="stat-label">Paid out</div><div class="stat-value">${money(b.paid)}</div><div class="stat-sub">${st('SUCCEEDED').n} succeeded payouts</div></div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-receipt mr-2 text-slate-400"></i>Cash received</span></div>
          <div class="card-body"><dl class="kv">
            <dt>Payments</dt><dd>${s.payments.n}</dd>
            <dt>Gross</dt><dd>${money(s.payments.gross)}</dd>
            <dt>Platform fee</dt><dd>${money(s.payments.fee)}</dd>
            <dt>Distributable</dt><dd class="font-semibold">${money(s.payments.dist)}</dd>
            <dt>Still unearned</dt><dd class="text-slate-500">${money(s.unrecognizedMinor)} <span class="text-xs">(deferred)</span></dd>
          </dl></div></div>

        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-diagram-project mr-2 text-slate-400"></i>Payout states</span></div>
          <div class="card-body"><dl class="kv">
            ${['PENDING', 'PROCESSING', 'VERIFY', 'SUCCEEDED', 'FAILED'].map((k) => `<dt>${badge(k)}</dt><dd>${st(k).n} <span class="text-slate-400 text-xs">· ${money(st(k).amount)}</span></dd>`).join('')}
          </dl></div></div>

        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-shield-halved mr-2 text-slate-400"></i>Integrity</span>${integ.ok ? '<span class="badge badge-SUCCEEDED"><i class="fas fa-check"></i> ALL INVARIANTS HOLD</span>' : '<span class="badge badge-FAILED"><i class="fas fa-xmark"></i> DRIFT DETECTED</span>'}</div>
          <div class="card-body text-sm space-y-2">
            <div class="flex justify-between"><span class="text-slate-500">Balance snapshot = Σ allocations</span><span>${integ.balanceChecks.filter((x) => x.ok).length}/${integ.balanceChecks.length} ok</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Σ allocated = distributable</span><span>${integ.paymentsWithBadAllocationSum === 0 ? '<i class="fas fa-check text-emerald-500"></i>' : integ.paymentsWithBadAllocationSum + ' bad'}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">One provider tx per key</span><span>${integ.duplicateProviderTransactions === 0 ? '<i class="fas fa-check text-emerald-500"></i>' : integ.duplicateProviderTransactions + ' dup'}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Last payout cycle</span><span>${s.payoutsLastRun ? dayjs(s.payoutsLastRun).fromNow() : 'never'}</span></div>
          </div></div>
      </div>

      <div class="card"><div class="card-header"><span class="card-title">Recent payouts</span><a href="#/payouts" class="text-sm text-emerald-600 hover:underline">View all →</a></div>
        ${payoutTable(pays.payouts)}</div>`
  }

  function payoutTable(rows) {
    if (!rows.length) return '<div class="empty">No payouts yet. Run the payout cycle from the Ops console.</div>'
    return `<table class="ledger"><thead><tr><th>#</th><th>Instructor</th><th>Status</th><th class="num">Amount</th><th>Provider tx</th><th>Idempotency key</th><th class="num">Attempts</th><th>Created</th><th>Completed</th></tr></thead><tbody>
      ${rows.map((p) => `<tr class="clickable" data-href="#/payouts/${p.id}">
        <td class="mono">${p.id}</td><td>${esc(p.instructor_name)}</td><td>${badge(p.status)}</td><td class="num font-semibold">${money(p.amount_minor, p.currency)}</td>
        <td>${short(p.provider_transaction_id, 16)}</td><td>${short(p.idempotency_key, 22)}</td><td class="num">${p.attempt_count}</td><td>${when(p.created_at)}</td><td>${when(p.completed_at)}</td></tr>`).join('')}
    </tbody></table>`
  }

  views.instructors = async () => {
    $title.textContent = 'Instructor balances'
    const { data } = await api.get('/instructors')
    $view.innerHTML = `<div class="card">
      <div class="card-header"><span class="card-title">Balance snapshot per instructor</span><span class="text-xs text-slate-500">Available = Earned − Reserved − Paid</span></div>
      ${data.instructors.length ? `<table class="ledger"><thead><tr><th>Instructor</th><th>Provider account</th><th>Currency</th><th class="num">Lifetime allocated</th><th class="num">Earned</th><th class="num">Reserved</th><th class="num">Paid</th><th class="num">Available</th><th>Last payout</th></tr></thead><tbody>
        ${data.instructors.map((i) => `<tr class="clickable" data-href="#/instructors/${i.id}">
          <td><div class="font-medium">${esc(i.name)}</div><div class="text-xs text-slate-500">${esc(i.email)} · #${i.id}</div></td>
          <td class="mono">${esc(i.provider_account_id)}</td><td>${esc(i.currency)}</td>
          <td class="num text-slate-500">${money(i.lifetime_allocated_minor, i.currency)}</td>
          <td class="num">${money(i.earned_minor, i.currency)}</td>
          <td class="num ${i.reserved_minor > 0 ? 'text-amber-600' : ''}">${money(i.reserved_minor, i.currency)}</td>
          <td class="num">${money(i.paid_minor, i.currency)}</td>
          <td class="num font-semibold ${i.available_minor > 0 ? 'text-emerald-600' : ''}">${money(i.available_minor, i.currency)}</td>
          <td>${i.last_payout_id ? `${badge(i.last_payout_status)} <span class="text-xs text-slate-500">${money(i.last_payout_amount)} · ${dayjs(i.last_payout_at).fromNow()}</span>` : '<span class="text-slate-400 text-xs">none</span>'}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">No instructors. Seed demo data from Overview.</div>'}
    </div>`
  }

  views.instructor = async (id) => {
    const { data } = await api.get(`/instructors/${id}`)
    const i = data.instructor
    $title.innerHTML = `<a href="#/instructors" class="text-slate-400 hover:text-slate-600">Instructors</a> <span class="text-slate-300">/</span> ${esc(i.name)}`
    const available = (i.earned_minor ?? 0) - (i.paid_minor ?? 0) - (i.reserved_minor ?? 0)
    $view.innerHTML = `
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div class="stat"><div class="stat-label">Earned</div><div class="stat-value">${money(i.earned_minor)}</div></div>
        <div class="stat"><div class="stat-label">Reserved</div><div class="stat-value text-amber-600">${money(i.reserved_minor)}</div></div>
        <div class="stat"><div class="stat-label">Paid</div><div class="stat-value">${money(i.paid_minor)}</div></div>
        <div class="stat"><div class="stat-label">Available</div><div class="stat-value text-emerald-600">${money(available)}</div><div class="stat-sub">balance v${i.version ?? 0}</div></div>
      </div>
      <div class="card mb-6"><div class="card-header"><span class="card-title">Revenue allocations</span><span class="text-xs text-slate-500">Straight-line recognition over each term</span></div>
        ${data.allocations.length ? `<table class="ledger"><thead><tr><th>#</th><th>Payment</th><th>Student / plan</th><th>Term</th><th class="num">Allocated</th><th class="num">Refunded</th><th class="num">Recognized</th><th class="num">Reserved</th><th class="num">Paid</th><th style="min-width:9rem">Progress</th></tr></thead><tbody>
          ${data.allocations.map((a) => {
            const base = a.allocated_minor - a.refunded_minor
            return `<tr class="clickable" data-href="#/payments/${a.payment_id}">
            <td class="mono">${a.id}</td><td>${short(a.provider_payment_id, 14)}<div class="text-xs text-slate-400">${money(a.payment_gross_minor)} gross</div></td>
            <td>${esc(a.student_name)}<div class="text-xs text-slate-500">${esc(a.plan_code)}</div></td>
            <td class="text-xs">${dayjs(a.term_start_at).format('YYYY-MM-DD')} →<br>${dayjs(a.term_end_at).format('YYYY-MM-DD')}</td>
            <td class="num">${money(a.allocated_minor)}</td><td class="num ${a.refunded_minor ? 'text-red-600' : 'text-slate-400'}">${money(a.refunded_minor)}</td>
            <td class="num">${money(a.recognized_minor)}</td><td class="num ${a.reserved_minor ? 'text-amber-600' : 'text-slate-400'}">${money(a.reserved_minor)}</td><td class="num">${money(a.paid_minor)}</td>
            <td><div class="progress"><span style="width:${pct(a.recognized_minor, base)}%"></span></div><div class="text-xs text-slate-500 mt-1">${pct(a.recognized_minor, base)}% recognized</div></td></tr>`
          }).join('')}</tbody></table>` : '<div class="empty">No allocations.</div>'}
      </div>
      <div class="card"><div class="card-header"><span class="card-title">Payout history</span></div>${payoutTable(data.payouts.map((p) => ({ ...p, instructor_name: i.name })))}</div>`
  }

  views.payouts = async () => {
    $title.textContent = 'Payout history'
    const q = new URLSearchParams(location.hash.split('?')[1] || '')
    const status = q.get('status') || ''
    const from = q.get('from') || ''
    const to = q.get('to') || ''
    const { data } = await api.get('/payouts', { params: { status: status || undefined, from: from || undefined, to: to || undefined, limit: 200 } })
    $view.innerHTML = `
      <form id="payout-filter" class="card mb-4"><div class="card-body flex flex-wrap items-end gap-4">
        <label class="field">Status<select name="status">${['', 'PENDING', 'PROCESSING', 'VERIFY', 'SUCCEEDED', 'FAILED'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${s || 'All'}</option>`).join('')}</select></label>
        <label class="field">Created from<input type="date" name="from" value="${esc(from)}"></label>
        <label class="field">Created to<input type="date" name="to" value="${esc(to)}"></label>
        <button class="btn-secondary" type="submit"><i class="fas fa-filter"></i> Filter</button>
        <a href="#/payouts" class="btn-ghost">Clear</a>
        <span class="ml-auto text-sm text-slate-500">${data.payouts.length} payout(s)</span>
      </div></form>
      <div class="card">${payoutTable(data.payouts)}</div>`
    document.getElementById('payout-filter').addEventListener('submit', (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      const p = new URLSearchParams()
      for (const [k, v] of f.entries()) if (v) p.set(k, v)
      location.hash = '#/payouts' + (p.toString() ? '?' + p.toString() : '')
    })
  }

  views.payout = async (id) => {
    const { data } = await api.get(`/payouts/${id}`)
    const p = data.payout
    $title.innerHTML = `<a href="#/payouts" class="text-slate-400 hover:text-slate-600">Payouts</a> <span class="text-slate-300">/</span> Payout #${p.id} ${badge(p.status)}`
    const pr = data.providerRecord
    $view.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div class="card lg:col-span-2"><div class="card-header"><span class="card-title">Settlement intent</span><span class="text-xs text-slate-500">read-only</span></div>
          <div class="card-body"><dl class="kv">
            <dt>Instructor</dt><dd><a href="#/instructors/${p.instructor_id}" class="text-emerald-700 hover:underline">${esc(p.instructor_name)}</a> <span class="text-slate-400 text-xs">${esc(p.instructor_email)}</span></dd>
            <dt>Amount</dt><dd class="font-semibold text-base">${money(p.amount_minor, p.currency)}</dd>
            <dt>Destination</dt><dd class="mono">${esc(p.provider_account_id)}</dd>
            <dt>Idempotency key</dt><dd class="mono">${esc(p.idempotency_key)}</dd>
            <dt>Provider tx</dt><dd class="mono">${esc(p.provider_transaction_id ?? '—')}</dd>
            <dt>Provider outcome</dt><dd>${esc(p.provider_outcome ?? '—')}${p.failure_reason ? ` <span class="text-red-600 text-xs">· ${esc(p.failure_reason)}</span>` : ''}</dd>
            <dt>Attempts</dt><dd>${p.attempt_count}</dd>
            <dt>Created</dt><dd>${when(p.created_at)}</dd>
            <dt>Processing started</dt><dd>${when(p.processing_started_at)}</dd>
            <dt>Completed</dt><dd>${when(p.completed_at)}</dd>
            ${p.next_check_at ? `<dt>Next reconciliation</dt><dd>${when(p.next_check_at)}</dd>` : ''}
          </dl></div></div>
        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-plug mr-2 text-slate-400"></i>Provider-side record</span></div>
          <div class="card-body text-sm">${pr ? `<dl class="kv"><dt>Status</dt><dd>${badge(pr.status)}</dd><dt>Tx id</dt><dd class="mono">${esc(pr.provider_transaction_id)}</dd><dt>Scenario</dt><dd>${esc(pr.scenario)}</dd><dt>Create calls</dt><dd>${pr.call_count} <span class="text-xs text-slate-400">(idempotent replays)</span></dd></dl>` : '<div class="text-slate-500">Provider has no record for this key — the create call never landed.</div>'}
          <div class="mt-4 state-diagram">PENDING → PROCESSING → SUCCEEDED
                  ├────────→ FAILED
                  └→ VERIFY → SUCCEEDED | FAILED
                       ↺ (UNKNOWN: keep reservation)</div></div></div>
      </div>
      <div class="card mb-6"><div class="card-header"><span class="card-title">Payout items → underlying allocations</span><span class="text-xs text-slate-500">payout → items → allocation → payment (full trace)</span></div>
        <table class="ledger"><thead><tr><th>Item</th><th>Status</th><th class="num">Item amount</th><th>Allocation</th><th>Payment</th><th>Student / plan</th><th>Term</th><th class="num">Allocated</th><th class="num">Recognized</th><th class="num">Alloc paid</th></tr></thead><tbody>
          ${data.items.map((it) => `<tr class="clickable" data-href="#/payments/${it.payment_id}"><td class="mono">${it.id}</td><td>${badge(it.status)}</td><td class="num font-semibold">${money(it.amount_minor)}</td><td class="mono">#${it.allocation_id}</td>
            <td>${short(it.provider_payment_id, 14)}<div class="text-xs text-slate-400">${money(it.payment_gross_minor)} gross</div></td><td>${esc(it.student_name)}<div class="text-xs text-slate-500">${esc(it.plan_code)}</div></td>
            <td class="text-xs">${dayjs(it.term_start_at).format('YYYY-MM-DD')} → ${dayjs(it.term_end_at).format('YYYY-MM-DD')}</td>
            <td class="num">${money(it.allocated_minor)}</td><td class="num">${money(it.recognized_minor)}</td><td class="num">${money(it.alloc_paid_minor)}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="card"><div class="card-header"><span class="card-title">Structured event log</span></div><div class="card-body">${eventList(data.events)}</div></div>`
  }

  function eventList(events) {
    if (!events.length) return '<div class="empty">No events.</div>'
    return events.map((e) => `<div class="event-row"><div class="text-xs text-slate-500">${when(e.created_at)}<div class="mono">#${e.id}</div></div>
      <div><span class="mono font-semibold text-slate-800">${esc(e.event)}</span>
        ${e.old_status || e.new_status ? `<span class="ml-2 text-xs">${e.old_status ? badge(e.old_status) : ''} <i class="fas fa-arrow-right text-slate-300 mx-1"></i> ${e.new_status ? badge(e.new_status) : ''}</span>` : ''}
        <div class="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-3">
          ${e.payout_id ? `<a href="#/payouts/${e.payout_id}" class="hover:underline">payout #${e.payout_id}</a>` : ''}
          ${e.instructor_id ? `<a href="#/instructors/${e.instructor_id}" class="hover:underline">instructor #${e.instructor_id}</a>` : ''}
          ${e.amount_minor != null ? `<span>${money(e.amount_minor)}</span>` : ''}
          ${e.attempt != null ? `<span>attempt ${e.attempt}</span>` : ''}
          ${e.provider_transaction_id ? `<span class="mono">${esc(e.provider_transaction_id)}</span>` : ''}
        </div>
        ${e.context ? `<details class="mt-1 text-xs"><summary class="cursor-pointer text-slate-400">context</summary><pre class="mono bg-slate-50 p-2 rounded mt-1 overflow-auto">${esc(JSON.stringify(JSON.parse(e.context), null, 2))}</pre></details>` : ''}
      </div></div>`).join('')
  }

  views.payments = async () => {
    $title.textContent = 'Subscriptions & payments'
    const { data } = await api.get('/payments')
    $view.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">Prepaid subscription payments</span><span class="text-xs text-slate-500">distributable = gross − platform fee (bps stored per payment)</span></div>
      ${data.payments.length ? `<table class="ledger"><thead><tr><th>#</th><th>Provider payment</th><th>Student</th><th>Plan</th><th>Term</th><th class="num">Gross</th><th class="num">Fee</th><th class="num">Distributable</th><th class="num">Refunded</th><th class="num">Participants</th><th>Status</th></tr></thead><tbody>
        ${data.payments.map((p) => `<tr class="clickable" data-href="#/payments/${p.id}"><td class="mono">${p.id}</td><td>${short(p.provider_payment_id, 16)}</td><td>${esc(p.student_name)}</td><td>${esc(p.plan_code)} <span class="text-xs text-slate-400">${p.term_months}mo</span></td>
          <td class="text-xs">${dayjs(p.starts_at).format('YYYY-MM-DD')} → ${dayjs(p.ends_at).format('YYYY-MM-DD')}</td>
          <td class="num">${money(p.gross_minor)}</td><td class="num text-slate-500">${money(p.platform_fee_minor)} <span class="text-xs">(${(p.platform_fee_bps / 100).toFixed(2)}%)</span></td><td class="num font-semibold">${money(p.distributable_minor)}</td>
          <td class="num ${p.refunded_minor ? 'text-red-600' : 'text-slate-400'}">${money(p.refunded_minor)}</td><td class="num">${p.participant_count}</td><td>${badge(p.status)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No payments yet.</div>'}
    </div>`
  }

  views.payment = async (id) => {
    const { data } = await api.get(`/payments/${id}`)
    const p = data.payment
    $title.innerHTML = `<a href="#/payments" class="text-slate-400 hover:text-slate-600">Payments</a> <span class="text-slate-300">/</span> Payment #${p.id} ${badge(p.status)}`
    const sum = data.allocations.reduce((s, a) => s + a.allocated_minor, 0)
    $view.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div class="card"><div class="card-header"><span class="card-title">Payment fact</span></div><div class="card-body"><dl class="kv">
          <dt>Provider id</dt><dd class="mono">${esc(p.provider_payment_id)}</dd><dt>Idempotency</dt><dd class="mono">${esc(p.request_idempotency_key)}</dd>
          <dt>Student</dt><dd>${esc(p.student_name)}</dd><dt>Plan</dt><dd>${esc(p.plan_code)}</dd>
          <dt>Term</dt><dd>${dayjs(p.starts_at).format('YYYY-MM-DD')} → ${dayjs(p.ends_at).format('YYYY-MM-DD')} <span class="text-xs text-slate-400">[start, end)</span></dd>
          <dt>Paid at</dt><dd>${when(p.paid_at)}</dd></dl></div></div>
        <div class="card"><div class="card-header"><span class="card-title">Fee split</span></div><div class="card-body"><dl class="kv">
          <dt>Gross</dt><dd>${money(p.gross_minor)}</dd><dt>Fee rate</dt><dd>${p.platform_fee_bps} bps</dd><dt>Platform fee</dt><dd>${money(p.platform_fee_minor)}</dd>
          <dt>Distributable</dt><dd class="font-semibold">${money(p.distributable_minor)}</dd>
          <dt>Σ allocations</dt><dd>${money(sum)} ${sum === p.distributable_minor ? '<i class="fas fa-check text-emerald-500"></i>' : '<i class="fas fa-xmark text-red-500"></i>'}</dd></dl></div></div>
        <div class="card"><div class="card-header"><span class="card-title">Refunds</span></div><div class="card-body text-sm">
          ${data.refunds.length ? data.refunds.map((r) => `<div class="mb-3 pb-3 border-b last:border-0 last:mb-0 last:pb-0"><div class="flex justify-between"><span class="mono">${esc(r.provider_ref)}</span><span class="font-semibold">${money(r.refund_minor)}</span></div>
            <div class="text-xs text-slate-500 mt-1">instructor pool ${money(r.instructor_pool_minor)} · platform excess ${money(r.platform_excess_minor)} · ${when(r.processed_at)}</div></div>`).join('') : '<div class="text-slate-400">No refunds.</div>'}
        </div></div>
      </div>
      <div class="card"><div class="card-header"><span class="card-title">Allocation split (weighted largest remainder)</span></div>
        <table class="ledger"><thead><tr><th>#</th><th>Instructor</th><th class="num">Weight</th><th class="num">Allocated</th><th class="num">Refunded</th><th class="num">Recognized</th><th class="num">Reserved</th><th class="num">Paid</th><th class="num">Unearned</th></tr></thead><tbody>
          ${data.allocations.map((a) => `<tr class="clickable" data-href="#/instructors/${a.instructor_id}"><td class="mono">${a.id}</td><td>${esc(a.instructor_name)}</td><td class="num">${a.weight ?? 1}</td><td class="num font-semibold">${money(a.allocated_minor)}</td>
            <td class="num ${a.refunded_minor ? 'text-red-600' : 'text-slate-400'}">${money(a.refunded_minor)}</td><td class="num">${money(a.recognized_minor)}</td><td class="num">${money(a.reserved_minor)}</td><td class="num">${money(a.paid_minor)}</td>
            <td class="num text-slate-500">${money(a.allocated_minor - a.refunded_minor - a.recognized_minor)}</td></tr>`).join('')}
        </tbody></table></div>`
  }

  views.events = async () => {
    $title.textContent = 'Audit log'
    const { data } = await api.get('/events?limit=200')
    $view.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">Structured ledger events</span><span class="text-xs text-slate-500">newest first · ${data.events.length} shown</span></div><div class="card-body">${eventList(data.events)}</div></div>`
  }

  views.ops = async () => {
    $title.textContent = 'Ops console'
    const [{ data: s }, { data: prov }, { data: instr }, { data: plans }, { data: students }, { data: pays }] = await Promise.all([
      api.get('/summary'), api.get('/ops/provider'), api.get('/instructors'), api.get('/plans'), api.get('/students'), api.get('/payments')
    ])
    const activePayouts = await api.get('/payouts?limit=50').then((r) => r.data.payouts.filter((p) => ['PENDING', 'PROCESSING', 'VERIFY'].includes(p.status)))
    $view.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-terminal mr-2 text-slate-400"></i>Commands & jobs</span></div><div class="card-body space-y-4 text-sm">
          <div class="flex items-center justify-between gap-4"><div><div class="font-medium mono">revenue:payouts</div><div class="text-xs text-slate-500">Recognize → find payable instructors → prepare + process one payout each. Safe to run twice.</div></div>
            <button class="btn-primary" data-action="run-payouts"><i class="fas fa-play"></i> Run cycle</button></div>
          <div class="flex items-center justify-between gap-4"><div><div class="font-medium mono">ReconcilePayout</div><div class="text-xs text-slate-500">Query provider status by idempotency key for VERIFY / stale PROCESSING payouts; finalize exactly once.</div></div>
            <button class="btn-secondary" data-action="reconcile"><i class="fas fa-magnifying-glass-dollar"></i> Reconcile</button></div>
          <div class="flex items-center justify-between gap-4"><div><div class="font-medium mono">Recognize revenue</div><div class="text-xs text-slate-500">Post earned-to-date deltas as of the current clock (normally done lazily inside prepare).</div></div>
            <button class="btn-secondary" data-action="recognize"><i class="fas fa-chart-line"></i> Recognize</button></div>
          <div class="border-t pt-4"><div class="font-medium mb-2">Replay a job for an existing payout <span class="text-xs text-slate-400 font-normal">(ProcessInstructorPayout twice = no second provider tx)</span></div>
            ${activePayouts.length ? activePayouts.map((p) => `<div class="flex items-center justify-between gap-3 py-1"><span>#${p.id} ${badge(p.status)} <span class="text-slate-500">${esc(p.instructor_name)} · ${money(p.amount_minor)}</span></span><button class="btn-secondary" data-action="process" data-id="${p.id}"><i class="fas fa-rotate-right"></i> Process again</button></div>`).join('')
              : `<div class="text-xs text-slate-400">No non-terminal payouts. Replaying a terminal payout is a no-op — try it from the row below.</div>
                 ${pays.payments.length ? `<div class="flex items-center gap-2 mt-2"><input id="replay-id" class="border rounded px-2 py-1 w-24" placeholder="payout #"><button class="btn-secondary" data-action="process-input"><i class="fas fa-rotate-right"></i> Process</button></div>` : ''}`}
          </div>
        </div></div>

        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-plug mr-2 text-slate-400"></i>Mock provider scenario</span>${badge(prov.scenario)}</div><div class="card-body text-sm">
          <div class="grid grid-cols-1 gap-2">
            ${[
              ['SUCCESS', 'Money moves, success returned → SUCCEEDED'],
              ['PERMANENT_FAILURE', 'No money moves, failure returned → FAILED, reservation released'],
              ['TIMEOUT_AFTER_SUCCESS', 'Money moves but caller times out → VERIFY (keep reservation). Reconcile finds SUCCESS.'],
              ['TIMEOUT_NO_EFFECT', 'Nothing stored, caller times out → VERIFY. Reconcile finds NOT_FOUND → FAILED.'],
              ['STATUS_UNKNOWN', 'Provider undecided → VERIFY with backoff. Switch scenario later and reconcile to settle.']
            ].map(([k, d]) => `<button class="text-left px-3 py-2 rounded-lg border ${prov.scenario === k ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}" data-action="scenario" data-scenario="${k}"><div class="mono font-semibold text-xs">${k}</div><div class="text-xs text-slate-500">${d}</div></button>`).join('')}
          </div></div></div>

        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-clock mr-2 text-slate-400"></i>Clock (time travel)</span><span class="text-xs ${s.frozenNow ? 'text-amber-600' : 'text-slate-500'}">${s.frozenNow ? 'FROZEN' : 'live'} · ${dayjs(s.now).format('YYYY-MM-DD HH:mm')} UTC</span></div><div class="card-body text-sm flex flex-wrap gap-2">
          ${[1, 7, 30, 90].map((d) => `<button class="btn-secondary" data-action="advance" data-days="${d}"><i class="fas fa-forward"></i> +${d}d</button>`).join('')}
          <button class="btn-ghost" data-action="unfreeze"><i class="fas fa-clock-rotate-left"></i> Back to real time</button>
          <div class="w-full text-xs text-slate-500 mt-1">Advancing the clock makes more of each prepaid term earned. Run the payout cycle afterwards to pay the newly recognized delta.</div>
        </div></div>

        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-database mr-2 text-slate-400"></i>Data</span></div><div class="card-body text-sm flex flex-wrap gap-2">
          <button class="btn-primary" data-action="seed"><i class="fas fa-seedling"></i> Seed demo data</button>
          <button class="btn-danger" data-action="reset"><i class="fas fa-trash"></i> Reset ledger</button>
          <div class="w-full text-xs text-slate-500 mt-1">Seed is idempotent. Reset wipes all financial rows (demo only — production never hard-deletes).</div>
        </div></div>

        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-receipt mr-2 text-slate-400"></i>Simulate settled payment webhook</span></div>
          <form id="payment-form" class="card-body grid grid-cols-2 gap-3 text-sm">
            <label class="field">Student<select name="userId">${students.students.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
            <label class="field">Plan<select name="planId">${plans.plans.map((p) => `<option value="${p.id}">${esc(p.name)} · ${money(p.price_minor)} · ${p.platform_fee_bps / 100}% fee</option>`).join('')}</select></label>
            <div class="col-span-2"><div class="text-xs text-slate-500 mb-1">Participating instructors (snapshot at payment time) · weight</div>
              <div class="grid grid-cols-2 gap-2">${instr.instructors.map((i) => `<label class="flex items-center gap-2"><input type="checkbox" name="inst" value="${i.id}" checked> <span class="flex-1">${esc(i.name)}</span><input type="number" min="1" value="1" name="w_${i.id}" class="w-14 border rounded px-1 py-0.5 text-xs"></label>`).join('')}</div></div>
            <label class="field col-span-2">Override gross (minor units, optional)<input type="number" name="grossMinor" placeholder="e.g. 10000 for $100.00"></label>
            <div class="col-span-2"><button class="btn-primary" type="submit" ${instr.instructors.length ? '' : 'disabled'}><i class="fas fa-plus"></i> Record payment</button></div>
          </form></div>

        <div class="card"><div class="card-header"><span class="card-title"><i class="fas fa-rotate-left mr-2 text-slate-400"></i>Simulate refund webhook</span></div>
          <form id="refund-form" class="card-body grid grid-cols-2 gap-3 text-sm">
            <label class="field col-span-2">Payment<select name="paymentId">${pays.payments.map((p) => `<option value="${p.id}">#${p.id} · ${esc(p.student_name)} · ${esc(p.plan_code)} · ${money(p.gross_minor)} · ${p.status}</option>`).join('')}</select></label>
            <label class="field">Refund amount (minor units)<input type="number" name="refundMinor" min="1" placeholder="e.g. 5000"></label>
            <div class="field justify-end"><button class="btn-secondary" type="submit" ${pays.payments.length ? '' : 'disabled'}><i class="fas fa-rotate-left"></i> Record refund</button></div>
            <div class="col-span-2 text-xs text-slate-500">Only the still-unearned instructor portion is taken from instructors; excess is recorded platform-side. Earned revenue is never clawed back.</div>
          </form></div>
      </div>`

    document.getElementById('payment-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      const participants = f.getAll('inst').map((id) => ({ instructorId: Number(id), weight: Number(f.get('w_' + id) || 1) }))
      if (!participants.length) return toast('Pick at least one instructor', { error: true })
      const body = { userId: Number(f.get('userId')), planId: Number(f.get('planId')), participants }
      if (f.get('grossMinor')) body.grossMinor = Number(f.get('grossMinor'))
      const r = await post('/ops/payments', body)
      toast(`Payment #${r.paymentId} recorded: ${money(r.grossMinor)} gross → ${money(r.distributableMinor)} distributable`, { detail: r.allocations })
      route()
    })
    document.getElementById('refund-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      const r = await post('/ops/refunds', { paymentId: Number(f.get('paymentId')), refundMinor: Number(f.get('refundMinor')) })
      toast(`Refund #${r.refundId}: ${money(r.instructorPoolMinor)} from instructors, ${money(r.platformExcessMinor)} platform excess`, { detail: r.lines })
      route()
    })
  }

  // ------------------------------------------------------------------ actions
  document.addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-href]')
    if (row && !e.target.closest('a,button')) { location.hash = row.dataset.href; return }
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const a = btn.dataset.action
    btn.disabled = true
    try {
      if (a === 'seed') { const r = await post('/ops/seed'); toast(r.seeded ? 'Demo data seeded' : 'Already seeded (idempotent)'); }
      else if (a === 'reset') { if (!confirm('Wipe all ledger data?')) return; await post('/ops/reset'); toast('Ledger reset') }
      else if (a === 'run-payouts') { const r = await post('/ops/payouts/run'); toast(`Payout cycle: ${r.candidates} candidate(s), ${r.results.filter((x) => x.prepared).length} payout(s) created`, { detail: r.results }) }
      else if (a === 'reconcile') { const r = await post('/ops/reconcile'); toast(`Reconciled ${r.reconciled.length} payout(s)`, { detail: r.reconciled }) }
      else if (a === 'recognize') { const r = await post('/ops/recognize'); const total = r.posted.reduce((s, x) => s + x.deltaMinor, 0); toast(`Recognized ${money(total)} across ${r.posted.length} instructor(s) as of ${dayjs(r.asOf).format('YYYY-MM-DD')}`) }
      else if (a === 'process') { const r = await post(`/ops/payouts/${btn.dataset.id}/process`); toast(`Payout #${r.payoutId}: ${r.before} → ${r.after} · provider called: ${r.providerCalled}`, { detail: r.note }) }
      else if (a === 'process-input') { const id = document.getElementById('replay-id').value; if (!id) return; const r = await post(`/ops/payouts/${id}/process`); toast(`Payout #${r.payoutId}: ${r.before} → ${r.after} · provider called: ${r.providerCalled}`, { detail: r.note }) }
      else if (a === 'scenario') { await post('/ops/provider', { scenario: btn.dataset.scenario }); toast(`Provider scenario → ${btn.dataset.scenario}`) }
      else if (a === 'advance') { const r = await post('/ops/clock', { advanceDays: Number(btn.dataset.days) }); toast(`Clock frozen at ${dayjs(r.frozenNow).format('YYYY-MM-DD HH:mm')} UTC`) }
      else if (a === 'unfreeze') { await post('/ops/clock', { now: null }); toast('Clock back to real time') }
      await refreshBadges()
      route()
    } catch { /* toast already shown */ } finally { btn.disabled = false }
  })
  document.getElementById('refresh-btn').addEventListener('click', () => { refreshBadges(); route() })

  // ------------------------------------------------------------------ router
  async function route() {
    const hash = (location.hash || '#/overview').slice(2)
    const [path] = hash.split('?')
    const parts = path.split('/')
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === parts[0]))
    $view.innerHTML = '<div class="empty"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</div>'
    try {
      if (parts[0] === 'instructors' && parts[1]) await views.instructor(parts[1])
      else if (parts[0] === 'payouts' && parts[1]) await views.payout(parts[1])
      else if (parts[0] === 'payments' && parts[1]) await views.payment(parts[1])
      else if (views[parts[0]]) await views[parts[0]]()
      else await views.overview()
    } catch (e) {
      $view.innerHTML = `<div class="card"><div class="card-body text-red-700"><i class="fas fa-triangle-exclamation mr-2"></i>${esc(e.response?.data?.error || e.message)}</div></div>`
    }
  }

  // Support server-rendered deep links like /payouts/3 -> #/payouts/3
  const m = location.pathname.match(/^\/(payouts|instructors|payments)\/(\d+)$/)
  if (m) history.replaceState(null, '', `/#/${m[1]}/${m[2]}`)

  window.addEventListener('hashchange', route)
  refreshBadges()
  route()
})()
