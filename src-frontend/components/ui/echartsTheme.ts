// Nexum light ECharts theme (CONTRACT §4.7, §4.9; docs/design/SPEC.md §25). Owner: foundation.
// Copied from the design package (design-final/echarts-theme.ts); the values equal styles/nexum.css.
// EChart.tsx registers it once:  echarts.registerTheme(NEXUM_CHART_THEME, NEXUM_LIGHT_THEME)
// The theme name stays "nexum", so no call site changes. Build multi-series lines with nexumLine()
// so every line end carries its live value (no legend row, tooltip on hover only).
// This file and tones.ts are the only TS files that may contain hex colours.
import type { LineSeriesOption } from "echarts";

export const NEXUM_CHART_THEME = "nexum";

/** Series colours: never red, amber or green (brand/status). VRAM is graphite AND dashed. */
export const SERIES_HEX = {
  "cpu": "#1e4fc2",
  "gpu": "#0e97a6",
  "ram": "#b06cf0",
  "vram": "#5b5b61",
  "disk": "#1e4fc2",
  "net": "#0e97a6",
  "single": "#3a3a3e",
  "neutral": "#8e8e95"
} as const;

export const NEXUM_LIGHT_THEME = {
  "color": [
    "#1e4fc2",
    "#0e97a6",
    "#b06cf0",
    "#5b5b61",
    "#8e8e95"
  ],
  "backgroundColor": "transparent",
  "textStyle": {
    "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
    "color": "#5f5f65",
    "fontSize": 12
  },
  "title": {
    "textStyle": {
      "color": "#1d1d1f",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 15,
      "fontWeight": 600
    },
    "subtextStyle": {
      "color": "#5f5f65",
      "fontSize": 12
    }
  },
  "legend": {
    "show": false,
    "textStyle": {
      "color": "#5f5f65",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 12
    },
    "icon": "roundRect",
    "itemWidth": 12,
    "itemHeight": 3
  },
  "grid": {
    "left": 38,
    "right": 92,
    "top": 8,
    "bottom": 24,
    "containLabel": false
  },
  "tooltip": {
    "trigger": "axis",
    "show": true,
    "showDelay": 0,
    "confine": true,
    "backgroundColor": "#ffffff",
    "borderWidth": 0,
    "padding": [
      9,
      11
    ],
    "textStyle": {
      "color": "#1d1d1f",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 12
    },
    "extraCssText": "border-radius:10px;box-shadow:0 0 0 .5px rgba(0,0,0,.10),0 10px 30px rgba(0,0,0,.14);font-variant-numeric:tabular-nums;",
    "axisPointer": {
      "type": "line",
      "lineStyle": {
        "color": "rgba(0,0,0,0.22)",
        "width": 1,
        "type": "solid"
      }
    }
  },
  "axisPointer": {
    "lineStyle": {
      "color": "rgba(0,0,0,0.22)"
    }
  },
  "categoryAxis": {
    "axisLine": {
      "show": true,
      "lineStyle": {
        "color": "#c9c9ce",
        "width": 1
      }
    },
    "axisTick": {
      "show": false
    },
    "axisLabel": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11,
      "fontWeight": 500
    },
    "splitLine": {
      "show": false,
      "lineStyle": {
        "color": "#ececef",
        "width": 1,
        "type": "solid"
      }
    },
    "splitArea": {
      "show": false
    },
    "nameTextStyle": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11
    }
  },
  "valueAxis": {
    "axisLine": {
      "show": false
    },
    "axisTick": {
      "show": false
    },
    "axisLabel": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11,
      "fontWeight": 500
    },
    "splitLine": {
      "show": true,
      "lineStyle": {
        "color": "#ececef",
        "width": 1,
        "type": "solid"
      }
    },
    "splitArea": {
      "show": false
    },
    "nameTextStyle": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11
    }
  },
  "timeAxis": {
    "axisLine": {
      "show": true,
      "lineStyle": {
        "color": "#c9c9ce",
        "width": 1
      }
    },
    "axisTick": {
      "show": false
    },
    "axisLabel": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11,
      "fontWeight": 500
    },
    "splitLine": {
      "show": false,
      "lineStyle": {
        "color": "#ececef",
        "width": 1,
        "type": "solid"
      }
    },
    "splitArea": {
      "show": false
    },
    "nameTextStyle": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11
    }
  },
  "logAxis": {
    "axisLine": {
      "show": true,
      "lineStyle": {
        "color": "#c9c9ce",
        "width": 1
      }
    },
    "axisTick": {
      "show": false
    },
    "axisLabel": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11,
      "fontWeight": 500
    },
    "splitLine": {
      "show": true,
      "lineStyle": {
        "color": "#ececef",
        "width": 1,
        "type": "solid"
      }
    },
    "splitArea": {
      "show": false
    },
    "nameTextStyle": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11
    }
  },
  "line": {
    "symbol": "none",
    "smooth": false,
    "lineStyle": {
      "width": 1.75,
      "cap": "round",
      "join": "round"
    },
    "emphasis": {
      "disabled": true
    }
  },
  "bar": {
    "itemStyle": {
      "borderRadius": [
        3,
        3,
        0,
        0
      ]
    }
  },
  "gauge": {
    "axisLine": {
      "lineStyle": {
        "color": [
          [
            1,
            "#ebebee"
          ]
        ]
      }
    },
    "title": {
      "color": "#5f5f65"
    },
    "detail": {
      "color": "#1d1d1f",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif"
    }
  },
  "markLine": {
    "symbol": "none",
    "lineStyle": {
      "color": "#b9b9bf",
      "type": [
        4,
        4
      ],
      "width": 1
    },
    "label": {
      "color": "#646469",
      "fontFamily": "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      "fontSize": 11
    }
  }
};

export type SeriesKey = keyof typeof SERIES_HEX;

/** Chart chrome colours for options the theme cannot preset (markLine, custom axes, SVG charts). */
export const CHART_HEX = {
  grid: "#ececef",
  axis: "#c9c9ce",
  refLine: "#b9b9bf",
  label: "#646469",
  text: "#5f5f65",
  ink: "#1d1d1f",
  crosshair: "rgba(0,0,0,0.22)",
  meterTrack: "#ebebee",
} as const;

/** Font stack for chart text (the same as --font-sans). */
export const CHART_FONT = "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif";

/** Dash pattern of the VRAM line (graphite AND dashed, so identity never depends on hue). */
export const VRAM_DASH: readonly [number, number] = [4, 3];

/** Grid margins that leave room for nexumLine() end labels. */
export const CHART_GRID_WITH_END_LABELS = { left: 38, right: 92, top: 8, bottom: 24, containLabel: false } as const;

/**
 * A themed line series. endLabel shows "<value><unit> <name>" at the right end of the line
 * (no frozen tooltip in the default state; the axis tooltip appears only on hover).
 * Give the grid a right margin of ~92 px so end labels fit.
 */
export function nexumLine(name: string, key: SeriesKey, data: Array<number | null>, unit = "%", opts: Partial<LineSeriesOption> = {}): LineSeriesOption {
  const color = SERIES_HEX[key];
  return {
    type: "line",
    name,
    data,
    showSymbol: false,
    connectNulls: false,
    animation: false,
    color,
    lineStyle: { width: 1.75, color, type: key === "vram" ? [4, 3] : "solid" },
    areaStyle: key === "cpu" ? { color, opacity: 0.07 } : undefined,
    endLabel: {
      show: true,
      distance: 8,
      padding: [3, 0],
      lineHeight: 16,
      fontFamily: "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif",
      fontSize: 11.5,
      fontWeight: 500,
      color: "#5f5f65",
      formatter: (p: { value?: unknown }) => {
        const v = Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value;
        return v == null ? "" : `{s|} {v|${Math.round(Number(v))}${unit}} ${name}`;
      },
      rich: {
        s: { width: 10, height: 2.5, borderRadius: 2, backgroundColor: color },
        v: { color: "#1d1d1f", fontWeight: 600, fontFamily: "\"Inter\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif", fontSize: 11.5 },
      },
    },
    labelLayout: { moveOverlap: "shiftY" },
    emphasis: { disabled: true },
    ...opts,
  };
}

/** Reference lines for frame times (60/120/144 Hz), dashed, labelled on the right. */
export const FRAMETIME_MARKLINE = {
  symbol: "none",
  silent: true,
  lineStyle: { color: "#b9b9bf", type: [4, 4], width: 1 },
  label: { position: "end" as const, color: "#646469", fontSize: 11, formatter: "{b} · {c}" },
  data: [
    { name: "60 Hz", yAxis: 16.7 },
    { name: "120 Hz", yAxis: 8.3 },
    { name: "144 Hz", yAxis: 6.9 },
  ],
};
