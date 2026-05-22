/**
 * Copy text to the clipboard with a fallback for non-secure contexts.
 *
 * `navigator.clipboard.writeText` ONLY works when the page is served
 * over HTTPS or from localhost / 127.0.0.1. Anyone accessing the admin
 * UI via a LAN IP (192.168.x.x, 10.x.x.x, .local mDNS names…) gets
 * `navigator.clipboard === undefined` and the await throws — which from
 * the user's side looks like the Copy button is broken.
 *
 * Fall back to the deprecated-but-universal `document.execCommand("copy")`
 * trick: stuff the text into a temporary off-screen textarea, select it,
 * fire execCommand, then clean up.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Preferred path — secure context, async, no DOM mutation.
  // TS types say navigator.clipboard.writeText always exists, but at
  // RUNTIME on http:// LAN deployments the whole `clipboard` object is
  // undefined. The defensive check is necessary even though lint thinks
  // otherwise.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path
    }
  }

  // Legacy path — works on LAN IPs / http://. execCommand is deprecated
  // but it's the only thing the Chrome / Firefox spec leaves us for
  // non-secure-context clipboard writes.
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "0"
    ta.style.left = "0"
    ta.style.opacity = "0"
    ta.style.pointerEvents = "none"
    document.body.append(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const ok = document.execCommand("copy")
    ta.remove()
    return ok
  } catch {
    return false
  }
}
