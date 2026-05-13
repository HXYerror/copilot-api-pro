// Copilot API Admin — usage dashboard interactivity.
// Loaded as an external script under default-src 'self' CSP.
// Reads the JSON payload emitted by page.tsx and renders three uPlot charts.
//
// Expected payload shape:
//   {
//     rpm:     [{ ts:number, model:string, count:number }, ...],
//     tokens:  [{ ts:number, prompt_tokens:number, completion_tokens:number }, ...],
//     latency: [{ ts:number, p95:number }, ...],
//     filter:  { since:number, until:number, ... }
//   }
(function () {
  "use strict"

  function readPayload() {
    var el = document.getElementById("usage-data")
    if (!el) return null
    try {
      return JSON.parse(el.textContent || "{}")
    } catch (_e) {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Theme colours — kept in sync with src/admin/assets/style.css
  // ---------------------------------------------------------------------------
  var THEME = {
    bg: "#1a1a1e",
    text: "#e2e2e8",
    grid: "#2e2e35",
    accent: "#7c6af7",
    accent2: "#4ade80",
    accent3: "#f87171",
    series: [
      "#7c6af7",
      "#4ade80",
      "#f87171",
      "#fbbf24",
      "#60a5fa",
      "#a78bfa",
      "#f472b6",
      "#34d399",
    ],
  }

  function makeAxes() {
    return [
      { stroke: THEME.text, grid: { stroke: THEME.grid } },
      { stroke: THEME.text, grid: { stroke: THEME.grid } },
    ]
  }

  function pickColour(i) {
    return THEME.series[i % THEME.series.length]
  }

  // ---------------------------------------------------------------------------
  // Helpers: bucket alignment + sparse → dense
  // ---------------------------------------------------------------------------
  function uniqSorted(values) {
    var s = {}
    for (var i = 0; i < values.length; i++) s[values[i]] = true
    var out = Object.keys(s)
      .map(Number)
      .sort(function (a, b) {
        return a - b
      })
    return out
  }

  // ---------------------------------------------------------------------------
  // requests-per-minute: one series per model
  // ---------------------------------------------------------------------------
  function renderRpm(points) {
    var el = document.getElementById("chart-rpm")
    if (!el || !window.uPlot) return
    if (!points || points.length === 0) {
      el.textContent = "(no data)"
      return
    }
    var times = uniqSorted(points.map(function (p) { return p.ts / 1000 }))
    var modelSet = {}
    for (var i = 0; i < points.length; i++) modelSet[points[i].model] = true
    var models = Object.keys(modelSet).sort()

    // Build a values-per-(model,time) lookup
    var lookup = {}
    for (var j = 0; j < points.length; j++) {
      var p = points[j]
      var key = p.model + "|" + (p.ts / 1000)
      lookup[key] = p.count
    }

    var data = [times]
    var series = [{}]
    for (var m = 0; m < models.length; m++) {
      var col = []
      for (var t = 0; t < times.length; t++) {
        col.push(lookup[models[m] + "|" + times[t]] || 0)
      }
      data.push(col)
      series.push({
        label: models[m],
        stroke: pickColour(m),
        width: 2,
      })
    }

    var opts = {
      width: el.clientWidth || 800,
      height: 240,
      series: series,
      axes: makeAxes(),
      legend: { show: true },
    }
    new window.uPlot(opts, data, el)
  }

  // ---------------------------------------------------------------------------
  // tokens-per-hour: stacked prompt + completion (rendered as two series)
  // ---------------------------------------------------------------------------
  function renderTokens(points) {
    var el = document.getElementById("chart-tph")
    if (!el || !window.uPlot) return
    if (!points || points.length === 0) {
      el.textContent = "(no data)"
      return
    }
    var times = []
    var prompt = []
    var completion = []
    for (var i = 0; i < points.length; i++) {
      times.push(points[i].ts / 1000)
      prompt.push(points[i].prompt_tokens)
      completion.push(points[i].completion_tokens)
    }
    var opts = {
      width: el.clientWidth || 800,
      height: 240,
      series: [
        {},
        { label: "prompt", stroke: THEME.accent, fill: "rgba(124,106,247,0.2)", width: 2 },
        { label: "completion", stroke: THEME.accent2, fill: "rgba(74,222,128,0.2)", width: 2 },
      ],
      axes: makeAxes(),
      legend: { show: true },
    }
    new window.uPlot(opts, [times, prompt, completion], el)
  }

  // ---------------------------------------------------------------------------
  // p95-latency-per-hour
  // ---------------------------------------------------------------------------
  function renderLatency(points) {
    var el = document.getElementById("chart-p95")
    if (!el || !window.uPlot) return
    if (!points || points.length === 0) {
      el.textContent = "(no data)"
      return
    }
    var times = []
    var values = []
    for (var i = 0; i < points.length; i++) {
      times.push(points[i].ts / 1000)
      values.push(points[i].p95)
    }
    var opts = {
      width: el.clientWidth || 800,
      height: 240,
      series: [
        {},
        { label: "p95 ms", stroke: THEME.accent3, width: 2 },
      ],
      axes: makeAxes(),
      legend: { show: true },
    }
    new window.uPlot(opts, [times, values], el)
  }

  function run() {
    var payload = readPayload()
    if (!payload) return
    renderRpm(payload.rpm || [])
    renderTokens(payload.tokens || [])
    renderLatency(payload.latency || [])
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run)
  } else {
    run()
  }
})()
