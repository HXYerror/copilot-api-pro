// Copilot API Admin — keys management interactivity
// Loaded as an external script under default-src 'self' CSP.
// No inline event handlers — all DOM wiring via addEventListener.
(function () {
  "use strict"

  // ---------------------------------------------------------------------------
  // Debug-checkbox confirmation modal (new key form)
  // ---------------------------------------------------------------------------
  function wireNewKeyDebugModal() {
    var cb = document.getElementById("debug-checkbox")
    var modal = document.getElementById("debug-modal")
    var confirmBtn = document.getElementById("debug-confirm")
    var cancelBtn = document.getElementById("debug-cancel")
    var hiddenConfirm = document.getElementById("debug-confirm-field")
    if (!cb || !modal || !confirmBtn || !cancelBtn || !hiddenConfirm) return
    var confirmed = false

    cb.addEventListener("change", function () {
      if (cb.checked && !confirmed) {
        cb.checked = false
        modal.style.display = "flex"
      } else if (!cb.checked) {
        confirmed = false
        hiddenConfirm.value = ""
      }
    })

    confirmBtn.addEventListener("click", function () {
      confirmed = true
      cb.checked = true
      hiddenConfirm.value = "yes"
      modal.style.display = "none"
    })

    cancelBtn.addEventListener("click", function () {
      confirmed = false
      cb.checked = false
      hiddenConfirm.value = ""
      modal.style.display = "none"
    })
  }

  // ---------------------------------------------------------------------------
  // Debug-enable button confirmation modal (detail page)
  // ---------------------------------------------------------------------------
  function wireDetailDebugModal() {
    var btn = document.getElementById("debug-btn")
    var modal = document.getElementById("debug-modal")
    var form = document.getElementById("debug-form")
    var confirmBtn = document.getElementById("debug-confirm")
    var cancelBtn = document.getElementById("debug-cancel")
    var hiddenConfirm = document.getElementById("debug-confirm-field")
    if (!btn || !modal || !form || !confirmBtn || !cancelBtn || !hiddenConfirm)
      return

    btn.addEventListener("click", function (e) {
      e.preventDefault()
      modal.style.display = "flex"
    })

    confirmBtn.addEventListener("click", function () {
      hiddenConfirm.value = "yes"
      modal.style.display = "none"
      form.submit()
    })

    cancelBtn.addEventListener("click", function () {
      modal.style.display = "none"
    })
  }

  // ---------------------------------------------------------------------------
  // Revoke-confirm dialogs (replaces inline onsubmit="return confirm(...)")
  // ---------------------------------------------------------------------------
  function wireRevokeForms() {
    var forms = document.querySelectorAll("form[data-confirm]")
    Array.prototype.forEach.call(forms, function (form) {
      form.addEventListener("submit", function (e) {
        var msg = form.getAttribute("data-confirm") || "Are you sure?"
        if (!window.confirm(msg)) e.preventDefault()
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Created-page: copy button + "I have copied" gate + beforeunload guard
  // ---------------------------------------------------------------------------
  function wireKeyCreatedPage() {
    var keyEl = document.getElementById("plain-key")
    var copyBtn = document.getElementById("copy-btn")
    var gate = document.getElementById("copied-gate")
    var link = document.getElementById("continue-link")
    if (!keyEl || !copyBtn || !gate || !link) return

    copyBtn.addEventListener("click", function () {
      var text = keyEl.textContent || ""
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            copyBtn.textContent = "Copied!"
          },
          function () {
            copyBtn.textContent = "Copy failed"
          },
        )
      }
    })

    gate.addEventListener("change", function () {
      link.style.pointerEvents = gate.checked ? "" : "none"
      link.style.opacity = gate.checked ? "1" : "0.5"
    })

    window.addEventListener("beforeunload", function (e) {
      if (!gate.checked) {
        e.preventDefault()
        e.returnValue = "Have you copied your API key?"
      }
    })
  }

  // Run all wirings once the DOM is ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      wireNewKeyDebugModal()
      wireDetailDebugModal()
      wireRevokeForms()
      wireKeyCreatedPage()
    })
  } else {
    wireNewKeyDebugModal()
    wireDetailDebugModal()
    wireRevokeForms()
    wireKeyCreatedPage()
  }
})()
