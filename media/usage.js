// @ts-check
/* Accounts & usage panel: one card per provider, fed by the provider APIs. */
(function () {
  const vscode = acquireVsCodeApi();
  const root = /** @type {HTMLElement} */ (document.getElementById('root'));

  /** @type {any[]} */
  let reports = [];
  let loading = true;

  /** @type {{lang: string, locale: string, strings: Record<string, string>}} */
  const I18N = /** @type {any} */ (window).PM_I18N ?? { lang: 'de', locale: 'de-DE', strings: {} };
  const LOCALE = I18N.locale;
  function t(key, vars) {
    const text = I18N.strings[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all)) : text;
  }

  const number = (value) => new Intl.NumberFormat(LOCALE).format(Math.round(value || 0));
  const money = (value) =>
    new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD' }).format(value || 0);

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
  }

  function render() {
    const grand = reports.reduce(
      (sum, report) => {
        sum.input += report.totals.inputTokens;
        sum.output += report.totals.outputTokens;
        sum.cache += report.totals.cacheReadTokens + report.totals.cacheWriteTokens;
        sum.cost += report.totals.costUsd;
        sum.requests += report.totals.requests;
        return sum;
      },
      { input: 0, output: 0, cache: 0, cost: 0, requests: 0 }
    );

    const range = reports[0]
      ? `${reports[0].from.slice(0, 10)} – ${reports[0].to.slice(0, 10)}`
      : '';

    root.innerHTML = `
<div class="usage">
  <div class="usage-head">
    <img class="head-logo" src="${document.body.dataset.logo ?? ''}" alt="" /><h1>${escapeHtml(t('usage.title'))}</h1>
    <button class="button" data-act="settings">${escapeHtml(t('usage.configure'))}</button>
    <button class="button primary" data-act="refresh">${escapeHtml(t(loading ? 'common.loading' : 'usage.refresh'))}</button>
  </div>
  <div class="usage-sub">${escapeHtml(range)} · ${escapeHtml(t('usage.source'))}</div>

  <div class="totals">
    <div class="tile"><div class="k">${escapeHtml(t('usage.totalCost'))}</div><div class="v">${money(grand.cost)}</div></div>
    <div class="tile"><div class="k">${escapeHtml(t('usage.inputTokens'))}</div><div class="v">${number(grand.input)}</div></div>
    <div class="tile"><div class="k">${escapeHtml(t('usage.outputTokens'))}</div><div class="v">${number(grand.output)}</div></div>
    <div class="tile"><div class="k">${escapeHtml(t('usage.cacheTokens'))}</div><div class="v">${number(grand.cache)}</div></div>
    <div class="tile"><div class="k">${escapeHtml(t('usage.requests'))}</div><div class="v">${number(grand.requests)}</div></div>
  </div>

  <div class="cards">${reports.map(renderCard).join('')}</div>
</div>`;

    document.querySelectorAll('[data-act]').forEach((element) => {
      element.addEventListener('click', () => {
        const act = element.getAttribute('data-act');
        if (act === 'refresh') {
          loading = true;
          render();
          vscode.postMessage({ type: 'refresh' });
        } else if (act === 'settings') {
          vscode.postMessage({ type: 'openSettings' });
        } else if (act === 'adminKey') {
          vscode.postMessage({ type: 'setAdminKey', providerId: element.getAttribute('data-provider') });
        }
      });
    });
  }

  function renderCard(report) {
    const max = Math.max(
      1,
      ...report.buckets.map((bucket) => bucket.inputTokens + bucket.outputTokens)
    );
    const bars = report.buckets
      .map((bucket) => {
        const value = bucket.inputTokens + bucket.outputTokens;
        const height = Math.max(1, Math.round((value / max) * 56));
        return `<div class="bar${value ? '' : ' empty'}" style="height:${height}px" title="${escapeHtml(t('usage.barTitle', { date: bucket.date, tokens: number(value), cost: money(bucket.costUsd) }))}"></div>`;
      })
      .join('');

    const models = report.byModel.length
      ? `<table class="models">
          <tr><th>${escapeHtml(t('usage.model'))}</th><th>${escapeHtml(t('usage.input'))}</th><th>${escapeHtml(t('usage.output'))}</th><th>${escapeHtml(t('usage.requests'))}</th></tr>
          ${report.byModel
            .slice(0, 8)
            .map(
              (entry) =>
                `<tr><td>${escapeHtml(entry.model)}</td><td>${number(entry.inputTokens)}</td><td>${number(
                  entry.outputTokens
                )}</td><td>${number(entry.requests)}</td></tr>`
            )
            .join('')}
        </table>`
      : '';

    return `<div class="card">
  <div class="card-head">
    <span class="name">${escapeHtml(report.providerLabel)}</span>
    <span class="badge">${escapeHtml(report.sourceKind)}</span>
    ${report.account ? `<span class="badge">${escapeHtml(report.account)}</span>` : ''}
    ${report.plan ? `<span class="badge">${escapeHtml(report.plan)}</span>` : ''}
    <span class="spacer"></span>
    <button class="button" data-act="adminKey" data-provider="${escapeHtml(report.providerId)}">${escapeHtml(t('usage.setAdminKey'))}</button>
  </div>
  <div class="metrics">
    <div class="metric"><div class="k">${escapeHtml(t('usage.cost'))}</div><div class="v">${money(report.totals.costUsd)}</div></div>
    <div class="metric"><div class="k">${escapeHtml(t('usage.input'))}</div><div class="v">${number(report.totals.inputTokens)}</div></div>
    <div class="metric"><div class="k">${escapeHtml(t('usage.output'))}</div><div class="v">${number(report.totals.outputTokens)}</div></div>
    <div class="metric"><div class="k">${escapeHtml(t('usage.cacheRead'))}</div><div class="v">${number(report.totals.cacheReadTokens)}</div></div>
    <div class="metric"><div class="k">${escapeHtml(t('usage.cacheWrite'))}</div><div class="v">${number(report.totals.cacheWriteTokens)}</div></div>
    <div class="metric"><div class="k">${escapeHtml(t('usage.requests'))}</div><div class="v">${number(report.totals.requests)}</div></div>
    ${
      typeof report.balanceUsd === 'number'
        ? `<div class="metric"><div class="k">${escapeHtml(t('usage.balance'))}</div><div class="v">${money(report.balanceUsd)}</div></div>`
        : ''
    }
  </div>
  ${renderRateLimit(report.rateLimit)}
  ${report.buckets.length > 1 ? `<div class="bars">${bars}</div>` : ''}
  ${models}
  ${report.error ? `<div class="note error">${escapeHtml(report.error)}</div>` : ''}
  ${report.hint ? `<div class="note">${escapeHtml(report.hint)}</div>` : ''}
</div>`;
  }

  const WINDOW_LABEL = { five_hour: t('usage.window5h'), seven_day: t('usage.window7d') };

  /** Subscription windows, captured from the provider CLI during chats. */
  function renderRateLimit(info) {
    if (!info || !info.windows?.length) {
      return '';
    }
    const rows = info.windows
      .map((entry) => {
        const percent = Math.min(100, Math.round(entry.utilization * 100));
        const reset = entry.resetsAt
          ? new Date(entry.resetsAt * 1000).toLocaleString(LOCALE)
          : '';
        return `<div class="limit">
          <div class="limit-head"><span>${escapeHtml(WINDOW_LABEL[entry.name] ?? entry.name)}</span><span>${percent}%${
            reset ? ` · ${escapeHtml(t('usage.reset', { time: reset }))}` : ''
          }</span></div>
          <div class="limit-track"><div class="limit-fill${percent >= 80 ? ' hot' : ''}" style="width:${percent}%"></div></div>
        </div>`;
      })
      .join('');
    return `<div class="limits">
      <div class="limits-title">${escapeHtml(t('usage.subscription'))}${info.isUsingOverage ? escapeHtml(t('usage.overage')) : ''} <span class="note">${escapeHtml(
        t('usage.asOf', { time: new Date(info.observedAt).toLocaleString(LOCALE) })
      )}</span></div>
      ${rows}
    </div>`;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'loading') {
      loading = true;
      render();
    } else if (message.type === 'reports') {
      reports = message.reports;
      loading = false;
      render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
