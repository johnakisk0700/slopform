interface ChartPoint {
  label?: string;
  value: number;
}

interface ChartSpec {
  type?: "bar" | "line" | "sparkline";
  title?: string;
  unit?: string;
  data: ChartPoint[];
}

const numberFormat = new Intl.NumberFormat("en-GB");

function formatValue(value: number, unit?: string): string {
  return `${numberFormat.format(value)}${unit ? ` ${unit}` : ""}`;
}

function parseSpec(source: string): ChartSpec | null {
  try {
    const spec = JSON.parse(source) as ChartSpec;
    if (!spec || !Array.isArray(spec.data) || spec.data.length === 0) {
      return null;
    }
    if (
      !spec.data.every(
        (point) =>
          point &&
          typeof point.value === "number" &&
          Number.isFinite(point.value),
      )
    ) {
      return null;
    }
    return spec;
  } catch {
    return null;
  }
}

/** Tiny dependency-free chart for model-authored fenced `chart` JSON. */
export function AssistantChart({ source }: { source: string }) {
  const spec = parseSpec(source);

  if (!spec) return <pre>{source}</pre>;

  const type = spec.type ?? "bar";
  return (
    <div className="assistant-chart">
      {spec.title ? (
        <div className="assistant-chart__title">{spec.title}</div>
      ) : null}
      {type === "bar" ? (
        <BarChart spec={spec} />
      ) : (
        <LineChart spec={spec} sparkline={type === "sparkline"} />
      )}
    </div>
  );
}

function BarChart({ spec }: { spec: ChartSpec }) {
  const max = Math.max(...spec.data.map((point) => point.value), 0);

  return (
    <div className="flex flex-col gap-1">
      {spec.data.map((point, index) => (
        <div
          key={`${point.label ?? "point"}-${index}`}
          className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2 text-xs"
        >
          <span className="truncate text-ink" title={point.label}>
            {point.label ?? index + 1}
          </span>
          <span className="h-3.5 w-full overflow-hidden rounded-xs bg-surface-sunken">
            <span
              className="block h-full rounded-xs border border-primary-border bg-primary-soft"
              style={{
                width:
                  max > 0
                    ? `${Math.max((point.value / max) * 100, 1.5)}%`
                    : "0%",
              }}
            />
          </span>
          <span className="font-medium tabular-nums text-ink">
            {formatValue(point.value, spec.unit)}
          </span>
        </div>
      ))}
    </div>
  );
}

function LineChart({
  spec,
  sparkline,
}: {
  spec: ChartSpec;
  sparkline: boolean;
}) {
  const width = 320;
  const height = sparkline ? 48 : 96;
  const paddingX = 6;
  const paddingY = sparkline ? 6 : 10;
  const values = spec.data.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const count = values.length;
  const x = (index: number) =>
    count <= 1
      ? width / 2
      : paddingX + (index * (width - 2 * paddingX)) / (count - 1);
  const y = (value: number) =>
    height - paddingY - ((value - min) / span) * (height - 2 * paddingY);
  const points = values.map(
    (value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`,
  );
  const linePath = `M ${points.join(" L ")}`;
  const areaPath = `M ${x(0).toFixed(1)},${(height - paddingY).toFixed(
    1,
  )} L ${points.join(" L ")} L ${x(count - 1).toFixed(
    1,
  )},${(height - paddingY).toFixed(1)} Z`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={spec.title ?? "Assistant generated chart"}
      >
        {!sparkline ? (
          <line
            className="assistant-chart-axis"
            x1={paddingX}
            y1={height - paddingY}
            x2={width - paddingX}
            y2={height - paddingY}
          />
        ) : null}
        <path className="assistant-chart-area" d={areaPath} />
        <path className="assistant-chart-line" d={linePath} />
        {!sparkline
          ? values.map((value, index) => (
              <circle
                key={`${value}-${index}`}
                className="assistant-chart-dot"
                cx={x(index)}
                cy={y(value)}
                r={2}
              />
            ))
          : null}
      </svg>
      {!sparkline ? (
        <div className="mt-1 flex justify-between text-[0.625rem] text-ink-muted">
          <span>{spec.data[0]?.label ?? ""}</span>
          <span>{spec.data[count - 1]?.label ?? ""}</span>
        </div>
      ) : null}
    </div>
  );
}
