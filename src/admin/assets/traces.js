// Copilot API Admin — debug capture live tail.
// Loaded as an external script under default-src 'self' CSP.
// Opens an EventSource to /admin/traces/stream and appends incoming lines
// to the <pre id="trace-log"> element. Keeps the most recent N lines.
(function () {
  "use strict"

  var MAX_LINES = 500
  var pre = document.getElementById("trace-log")
  if (!pre) return

  // Hard-cap how much DOM we keep; on a busy proxy this view is otherwise
  // an OOM grenade.
  var lines = []

  function render() {
    pre.textContent = lines.join("\n")
    // Pin to bottom so the newest line is visible.
    pre.scrollTop = pre.scrollHeight
  }

  function append(line) {
    lines.push(line)
    if (lines.length > MAX_LINES) {
      lines = lines.slice(lines.length - MAX_LINES)
    }
    render()
  }

  function pretty(jsonText) {
    try {
      var obj = JSON.parse(jsonText)
      // Single-line summary: timestamp, route, status, latency
      var ts = new Date(obj.ts || Date.now()).toISOString()
      var route = obj.route || "?"
      var status = (obj.res && obj.res.status) || "?"
      var latency = obj.latency_ms != null ? obj.latency_ms + "ms" : "?"
      var keyId = obj.key_id || "?"
      var summary =
        ts + "  " + status + "  " + route + "  " + latency + "  key=" + keyId
      return summary + "\n  " + jsonText
    } catch (_e) {
      return jsonText
    }
  }

  var src = new EventSource("/admin/traces/stream")
  src.addEventListener("message", function (ev) {
    append(pretty(ev.data))
  })
  src.addEventListener("error", function () {
    append("-- stream error; browser will auto-reconnect --")
  })
})()
