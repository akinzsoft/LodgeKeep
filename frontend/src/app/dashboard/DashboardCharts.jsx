import { useEffect, useId, useRef, useState } from 'react';
import styles from './DashboardCharts.module.css';

/**
 * The area chart draws in real pixels at its container's actual width, so
 * its axis text stays a true 12px at every card width — a stretched viewBox
 * (`preserveAspectRatio="none"`) would distort the labels, and a
 * proportionally-scaled one would shrink them below DESIGN_SYSTEM.md §1's
 * 12px floor on a phone. Falls back to a fixed width where ResizeObserver
 * doesn't exist (jsdom).
 */
function useMeasuredWidth(fallback) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof globalThis.ResizeObserver === 'undefined') return undefined;
    const observer = new globalThis.ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Hand-drawn SVG charts for the Home dashboard. This codebase bundles no
 * chart library (confirmed: `package.json` carries none) — three small,
 * purpose-built charts are far less weight than a general-purpose one.
 * Every colour comes from a CSS class referencing a `--chart-*` token, never
 * a literal in JS (eslint's hex-colour rule covers inline values too); SVG
 * gradient stops take theirs through `style={{ stopColor: 'var(...)' }}`.
 * Callers render an empty state instead of a chart when there is no data —
 * these components never draw a flat line pretending to be a trend.
 */

const TONE_CLASS = { primary: styles.tonePrimary, secondary: styles.toneSecondary };
const STOP_VAR = { primary: 'var(--chart-1)', secondary: 'var(--chart-2)' };

/** A smoothed path through points — quadratic curves between midpoints, so peaks never overshoot below zero the way a cubic spline can. */
function smoothPath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    path += index === 0 ? ` L ${midX} ${midY}` : ` Q ${current.x} ${current.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

function niceMax(value) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/**
 * @param {{key: string, label: string, tone: 'primary'|'secondary', values: number[]}[]} series
 * @param {string[]} labels   One x-axis label per value.
 * @param {number} [maxValue]   A fixed top of scale (e.g. 100 for a percentage); otherwise rounded up from the data.
 * @param {(tick: number) => string} [formatTick]   Y-axis label text.
 */
export function AreaChart({ series, labels, ariaLabel, maxValue, formatTick = defaultTick }) {
  const gradientPrefix = useId();
  const [containerRef, width] = useMeasuredWidth(600);
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = maxValue ?? niceMax(Math.max(...series.flatMap((entry) => entry.values), 0));
  const ticks = [0, max / 2, max];
  const x = (index) => pad.left + (labels.length === 1 ? innerWidth / 2 : (index / (labels.length - 1)) * innerWidth);
  const y = (value) => pad.top + innerHeight - (value / max) * innerHeight;

  return (
    <div ref={containerRef} className={styles.chartContainer}>
    <svg className={styles.chart} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      <defs>
        {series.map((entry) => (
          <linearGradient key={entry.key} id={`${gradientPrefix}-${entry.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: STOP_VAR[entry.tone], stopOpacity: 0.18 }} />
            <stop offset="100%" style={{ stopColor: STOP_VAR[entry.tone], stopOpacity: 0 }} />
          </linearGradient>
        ))}
      </defs>

      {ticks.map((tick) => (
        <g key={tick}>
          <line className={styles.gridLine} x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />
          <text className={styles.axisLabel} x={pad.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
            {formatTick(tick)}
          </text>
        </g>
      ))}

      {series.map((entry) => {
        const points = entry.values.map((value, index) => ({ x: x(index), y: y(value) }));
        const line = smoothPath(points);
        const baseline = pad.top + innerHeight;
        const area = `${line} L ${points[points.length - 1].x} ${baseline} L ${points[0].x} ${baseline} Z`;
        return (
          <g key={entry.key} className={TONE_CLASS[entry.tone]}>
            <path d={area} fill={`url(#${gradientPrefix}-${entry.key})`} stroke="none" />
            <path className={styles.seriesLine} d={line} />
          </g>
        );
      })}

      {labels.map((label, index) => (
        <text key={`${label}-${index}`} className={styles.axisLabel} x={x(index)} y={height - 8} textAnchor="middle">
          {label}
        </text>
      ))}
    </svg>
    </div>
  );
}

function defaultTick(tick) {
  return Number.isInteger(tick) ? String(tick) : tick.toFixed(1);
}

/** Axis text for money — 65000 → "65k", 1200000 → "1.2M". Chart geometry only; exact figures are shown elsewhere. */
export function compactNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(value));
}

/**
 * One bar per label — the daily-revenue chart. Same real-pixel sizing as
 * `AreaChart` (see `useMeasuredWidth`), so axis text stays 12px at any width.
 * `highlightIndex` gives one bar (the current business date) the full accent.
 *
 * @param {number[]} values
 * @param {string[]} labels
 */
export function BarChart({ values, labels, ariaLabel, formatTick = compactNumber, highlightIndex = null }) {
  const [containerRef, width] = useMeasuredWidth(600);
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...values, 0));
  const ticks = [0, max / 2, max];
  const slot = values.length > 0 ? innerWidth / values.length : innerWidth;
  const barWidth = Math.max(Math.min(slot * 0.56, 28), 4);
  const y = (value) => pad.top + innerHeight - (value / max) * innerHeight;

  return (
    <div ref={containerRef} className={styles.chartContainer}>
      <svg className={styles.chart} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className={styles.gridLine} x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />
            <text className={styles.axisLabel} x={pad.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {formatTick(tick)}
            </text>
          </g>
        ))}
        {values.map((value, index) => {
          const barHeight = Math.max(pad.top + innerHeight - y(value), value > 0 ? 2 : 0);
          return (
            <rect
              key={`${labels[index]}-${index}`}
              className={index === highlightIndex ? styles.barHighlight : styles.bar}
              x={pad.left + slot * index + (slot - barWidth) / 2}
              y={pad.top + innerHeight - barHeight}
              width={barWidth}
              height={barHeight}
              rx={3}
            />
          );
        })}
        {labels.map((label, index) => (
          <text key={`${label}-${index}`} className={styles.axisLabel} x={pad.left + slot * index + slot / 2} y={height - 8} textAnchor="middle">
            {label}
          </text>
        ))}
      </svg>
    </div>
  );
}

const SEGMENT_CLASSES = [styles.segment1, styles.segment2, styles.segment3, styles.segment4];

export function segmentClassName(index) {
  return SEGMENT_CLASSES[index % SEGMENT_CLASSES.length];
}

/** @param {{key: string, label: string, count: number, percent: number}[]} segments */
export function DonutChart({ segments, ariaLabel, centerValue, centerLabel }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  const arcs = segments.map((segment, index) => {
    const length = total === 0 ? 0 : (segment.count / total) * circumference;
    const start = segments.slice(0, index).reduce((sum, previous) => sum + (total === 0 ? 0 : (previous.count / total) * circumference), 0);
    return { segment, index, length, start };
  });

  return (
    <svg className={styles.donut} viewBox="0 0 120 120" role="img" aria-label={ariaLabel}>
      <circle className={styles.donutTrack} cx="60" cy="60" r={radius} />
      {arcs.map(({ segment, index, length, start }) => (
        <circle
          key={segment.key}
          className={`${styles.donutSegment} ${segmentClassName(index)}`}
          cx="60"
          cy="60"
          r={radius}
          strokeDasharray={`${length} ${circumference - length}`}
          strokeDashoffset={-start}
          transform="rotate(-90 60 60)"
        />
      ))}
      <text className={styles.donutValue} x="60" y="58" textAnchor="middle">
        {centerValue}
      </text>
      <text className={styles.donutCaption} x="60" y="74" textAnchor="middle">
        {centerLabel}
      </text>
    </svg>
  );
}

/** @param {number[]} values */
export function Sparkline({ values, ariaLabel }) {
  const gradientId = useId();
  const width = 120;
  const height = 36;
  const max = Math.max(...values, 0);
  const x = (index) => (values.length === 1 ? width / 2 : (index / (values.length - 1)) * width);
  const y = (value) => (max === 0 ? height - 2 : height - 2 - (value / max) * (height - 6));
  const points = values.map((value, index) => ({ x: x(index), y: y(value) }));
  const line = smoothPath(points);
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg className={styles.sparkline} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--chart-1)', stopOpacity: 0.2 }} />
          <stop offset="100%" style={{ stopColor: 'var(--chart-1)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} stroke="none" />
      <path className={`${styles.seriesLine} ${styles.tonePrimary}`} d={line} />
    </svg>
  );
}
