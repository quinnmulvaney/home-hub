// Small SVG chart helpers. Colors come from CSS variables so light/dark just work.
import { esc, money, pref } from './util.js';

export function niceMax(v, steps = 4) {
  if (!(v > 0)) return 100;
  const raw = v / steps;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].find((m) => m * p >= raw) * p * steps;
}

const compact = () => new Intl.NumberFormat(undefined, { style: 'currency', currency: pref('currency', 'USD'), notation: 'compact', maximumFractionDigits: 1 });

// Line chart over shared x labels. series: [{ name, cls: 'req'|'act'|'proj', values: [number|null] }]
// Renders a legend, the chart, and an accessible data table.
export function lineChart({ labels, series, aria }) {
  const W = 360, H = 170, L = 46, R = 10, T = 10, B = 22;
  const plotW = W - L - R, plotH = H - T - B;
  const n = labels.length;
  if (n < 2) return '';
  const max = niceMax(Math.max(...series.flatMap((s) => s.values.filter((v) => v != null)), 1));
  const x = (i) => L + (plotW * i) / (n - 1);
  const y = (v) => T + plotH - (v / max) * plotH;
  const fmt = compact();

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `
    <line x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}" class="grid ${f === 0 ? 'base' : ''}"/>
    <text x="${L - 6}" y="${y(max * f) + 3}" class="axis" text-anchor="end">${fmt.format(max * f)}</text>`).join('');

  const every = Math.max(1, Math.ceil(n / 5));
  const ticks = labels.map((l, i) => (i % every === 0 || i === n - 1)
    ? `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(l)}</text>` : '').join('');

  const lines = series.map((s) => {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
    if (pts.length < 2) return '';
    const last = pts[pts.length - 1];
    return `<polyline class="line ${s.cls}" points="${pts.map((p) => p.map((c) => c.toFixed(1)).join(',')).join(' ')}"/>
            <circle class="dot ${s.cls}" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5"/>`;
  }).join('');

  const rows = labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map((s) => `<td>${s.values[i] == null ? '' : money(s.values[i])}</td>`).join('')}</tr>`).join('');
  return `
    <div class="legend">${series.map((s) => `<span><i class="sw line-${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>
    <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(aria || 'Progress chart')}">${grid}${ticks}${lines}</svg>
    <details class="table-view"><summary>Show as table</summary>
      <table><thead><tr><th>Month</th>${series.map((s) => `<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    </details>`;
}

// Circular progress (0..1) with centered text.
export function ring(pct, label, sub = '') {
  const r = 34, c = 2 * Math.PI * r;
  return `
    <svg viewBox="0 0 88 88" class="ring" role="img" aria-label="${esc(label)}">
      <circle cx="44" cy="44" r="${r}" class="ring-bg"/>
      <circle cx="44" cy="44" r="${r}" class="ring-fg" stroke-dasharray="${(c * Math.min(Math.max(pct, 0), 1)).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 44 44)"/>
      <text x="44" y="${sub ? 44 : 49}" text-anchor="middle" class="ring-text">${esc(label)}</text>
      ${sub ? `<text x="44" y="58" text-anchor="middle" class="ring-sub">${esc(sub)}</text>` : ''}
    </svg>`;
}
