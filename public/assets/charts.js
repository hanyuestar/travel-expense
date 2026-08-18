/* charts.js — 手写 SVG 图表：环形图 donut + 柱状趋势 trend（沿用现有视觉） */
import { fmt, addYen } from './api.js';

export const CATS = ['交通', '机票', '高铁', '住宿', '餐饮', '门票', '团费', '购物', '其他'];
export const COLORS = {
  '交通': '#60a5fa', '机票': '#3b82f6', '高铁': '#06b6d4', '住宿': '#f59e0b',
  '餐饮': '#ef6b5e', '门票': '#a78bfa', '团费': '#ec4899', '购物': '#fb923c', '其他': '#94a3b8'
};

export function totalOf(r) {
  return CATS.reduce((s, c) => s + (parseFloat((r.exp && r.exp[c]) || 0) || 0), 0);
}

export function donut(data) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return '<div class="empty">暂无花费数据</div>';
  const r = 70, cx = 90, cy = 90, sw = 30, C = 2 * Math.PI * r;
  let off = 0, segs = '';
  data.forEach(d => {
    const len = d.value / total * C;
    segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" stroke-width="${sw}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += len;
  });
  return `<svg viewBox="0 0 180 180" class="chart">${segs}
    <text x="90" y="86" text-anchor="middle" class="donut-total">${addYen(total)}</text>
    <text x="90" y="106" text-anchor="middle" class="donut-sub">总花费</text></svg>`;
}

export function trendBar(points, xLabelKey) {
  /* points: [{label, value}]，value 为金额 */
  if (!points.length) return '<div class="empty">暂无数据</div>';
  const W = 520, H = 200, pad = 30;
  const max = Math.max(...points.map(p => p.value), 1);
  const bw = Math.min(70, (W - pad * 2) / points.length - 14);
  const gap = (W - pad * 2 - points.length * bw) / (points.length + 1);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" style="max-width:100%">`;
  s += `<line x1="${pad}" y1="${H - 30}" x2="${W - pad}" y2="${H - 30}" stroke="#e3efeb"/>`;
  points.forEach((p, i) => {
    const h = p.value / max * (H - 60);
    const x = pad + gap + i * (bw + gap);
    const y0 = (H - 30) - h;
    s += `<rect x="${x}" y="${y0}" width="${bw}" height="${h}" rx="6" fill="${COLORS['机票']}"
      opacity="${(0.55 + 0.45 * (p.value / max)).toFixed(2)}"><title>${esc(xLabelKey ? p[xLabelKey] : p.label)}：${addYen(p.value)}</title></rect>`;
    s += `<text x="${x + bw / 2}" y="${y0 - 6}" text-anchor="middle" font-size="12" fill="#1f2d2b" font-weight="700">${fmt(p.value)}</text>`;
    s += `<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle" font-size="12" fill="#6b7d79">${esc(p.label)}</text>`;
  });
  return s + '</svg>';
}

function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
