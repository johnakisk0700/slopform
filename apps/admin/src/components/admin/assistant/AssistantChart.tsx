interface ChartPoint {
  label?: string;
  value: number;
}

interface ChartSpec {
  type?: "bar" | "line" | "sparkline";
  title?: string;
  unit?: string;
  /**
   * Top of the scale the values are measured on, when that scale exists
   * independently of the data — a 1–5 rating being the case that matters. An
   * average of 4.2 drawn against the highest observed average reads as a full
   * bar; drawn against `max: 5` it reads as what it is.
   */
  max?: number;
  data: ChartPoint[];
}

const numberFormat = new Intl.NumberFormat("en-GB");

function formatValue(value: number, unit?: string): string {
  return `${numberFormat.format(value)}${unit ? ` ${unit}` : ""}`;
}

function parseSpec(source: string): ChartSpec | null {
  try {
    const candidate = JSON.parse(source) as unknown;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const spec = candidate as Record<string, unknown>;
    if (!Array.isArray(spec.data) || spec.data.length === 0) return null;
    if (
      spec.type !== undefined &&
      spec.type !== "bar" &&
      spec.type !== "line" &&
      spec.type !== "sparkline"
    ) {
      return null;
    }
    if (spec.title !== undefined && typeof spec.title !== "string") return null;
    if (spec.unit !== undefined && typeof spec.unit !== "string") return null;
    if (
      !spec.data.every(
        (point) =>
          point &&
          typeof point === "object" &&
          !Array.isArray(point) &&
          typeof (point as Record<string, unknown>).value === "number" &&
          Number.isFinite((point as Record<string, unknown>).value) &&
          ((point as Record<string, unknown>).label === undefined ||
            typeof (point as Record<string, unknown>).label === "string"),
      )
    ) {
      return null;
    }
    // An unusable ceiling drops out rather than failing the chart: the values
    // are still true, and falling back to code for one bad field would hide
    // them behind JSON.
    const normalized: ChartSpec = {
      ...(spec.type === undefined ? {} : { type: spec.type }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
      ...(spec.unit === undefined ? {} : { unit: spec.unit }),
      data: spec.data as ChartPoint[],
    };
    const { max } = spec;
    return typeof max === "number" && Number.isFinite(max) && max > 0
      ? { ...normalized, max }
      : normalized;
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
  const max = Math.max(
    ...spec.data.map((point) => point.value),
    spec.max ?? 0,
    0,
  );

  return (
    <div className="flex flex-col gap-1">
      {spec.data.map((point, index) => (
        <div
          key={`${point.label ?? "point"}-${index}`}
          className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 text-xs"
        >
          <span
            className="assistant-chart__label truncate text-ink"
            title={point.label}
          >
            {point.label ?? index + 1}
          </span>
          <span className="h-3.5 w-full overflow-hidden rounded-xs bg-surface-sunken">
            <span
              className="block h-full rounded-xs border border-primary-border bg-primary-soft"
              style={{
                width:
                  max > 0
                    ? `${Math.max(0, Math.min((point.value / max) * 100, 100))}%`
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
  // A declared ceiling describes an external scale, so the plot must not zoom
  // its bottom to the smallest observed value. Without a declared lower bound,
  // zero is the only honest baseline available.
  const min =
    spec.max === undefined ? Math.min(...values) : Math.min(0, ...values);
  const max = Math.max(...values, spec.max ?? Number.NEGATIVE_INFINITY);
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
        <div className="mt-1 flex justify-between text-[length:var(--jts-text-2xs)] text-ink-muted">
          <span>{spec.data[0]?.label ?? ""}</span>
          <span>{spec.data[count - 1]?.label ?? ""}</span>
        </div>
      ) : null}
    </div>
  );
}
