import { describe, expect, test } from "bun:test"

import {
  isLoopbackHost,
  logAuthModeBanner,
  resolveAuthMode,
} from "../src/lib/auth-mode"

// ---------------------------------------------------------------------------
// isLoopbackHost
// ---------------------------------------------------------------------------

describe("isLoopbackHost", () => {
  test("recognises common loopback literals", () => {
    expect(isLoopbackHost("localhost")).toBe(true)
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("127.1.2.3")).toBe(true)
    expect(isLoopbackHost("::1")).toBe(true)
    expect(isLoopbackHost("[::1]")).toBe(true)
  })

  test("is case-insensitive for hostname literals", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true)
    expect(isLoopbackHost("Localhost")).toBe(true)
  })

  test("trims whitespace", () => {
    expect(isLoopbackHost("127.0.0.1\n")).toBe(true)
    expect(isLoopbackHost("  localhost  ")).toBe(true)
  })

  test("recognises un-shortened IPv6 loopback (RFC 4291)", () => {
    expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true)
    expect(isLoopbackHost("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(true)
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true)
  })

  test("rejects non-loopback addresses", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false)
    expect(isLoopbackHost("192.168.1.1")).toBe(false)
    expect(isLoopbackHost("10.0.0.5")).toBe(false)
    expect(isLoopbackHost("::")).toBe(false)
    expect(isLoopbackHost("example.com")).toBe(false)
    expect(isLoopbackHost("")).toBe(false)
  })

  test("rejects look-alike IPv4 addresses", () => {
    expect(isLoopbackHost("128.0.0.1")).toBe(false)
    expect(isLoopbackHost("126.0.0.1")).toBe(false)
    expect(isLoopbackHost("127.0.0.999")).toBe(false)
    // No CIDR / port suffix should slip through
    expect(isLoopbackHost("127.0.0.1/24")).toBe(false)
    expect(isLoopbackHost("127.0.0.1:80")).toBe(false)
    // Subdomain-ish look-alikes
    expect(isLoopbackHost("127.0.0.1.attacker.com")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveAuthMode
// ---------------------------------------------------------------------------

describe("resolveAuthMode", () => {
  test("auth ON when --no-auth is not passed", () => {
    const result = resolveAuthMode({
      noAuth: false,
      acceptRisk: false,
      host: "0.0.0.0",
      port: 4141,
    })
    expect(result.authEnabled).toBe(true)
    expect(result.label).toBe("on")
    expect(result.bindAddress).toBe("0.0.0.0:4141")
  })

  test("--no-auth on loopback: allowed, label 'off (loopback)'", () => {
    const result = resolveAuthMode({
      noAuth: true,
      acceptRisk: false,
      host: "127.0.0.1",
      port: 4141,
    })
    expect(result.authEnabled).toBe(false)
    expect(result.label).toBe("off (loopback)")
  })

  test("--no-auth on IPv6 loopback: allowed", () => {
    const result = resolveAuthMode({
      noAuth: true,
      acceptRisk: false,
      host: "::1",
      port: 4141,
    })
    expect(result.label).toBe("off (loopback)")
  })

  test("--no-auth on non-loopback WITHOUT ack: throws descriptive error", () => {
    expect(() =>
      resolveAuthMode({
        noAuth: true,
        acceptRisk: false,
        host: "0.0.0.0",
        port: 4141,
      }),
    ).toThrow(/non-loopback/i)

    expect(() =>
      resolveAuthMode({
        noAuth: true,
        acceptRisk: false,
        host: "0.0.0.0",
        port: 4141,
      }),
    ).toThrow(/i-accept-account-suspension-risk/)
  })

  test("--no-auth on non-loopback WITH ack: allowed, label 'off (acknowledged risk)'", () => {
    const result = resolveAuthMode({
      noAuth: true,
      acceptRisk: true,
      host: "0.0.0.0",
      port: 4141,
    })
    expect(result.authEnabled).toBe(false)
    expect(result.label).toBe("off (acknowledged risk)")
  })

  test("acceptRisk without --no-auth is meaningless (auth still ON)", () => {
    const result = resolveAuthMode({
      noAuth: false,
      acceptRisk: true,
      host: "0.0.0.0",
      port: 4141,
    })
    expect(result.authEnabled).toBe(true)
    expect(result.label).toBe("on")
  })

  test("bindAddress includes host and port (IPv4)", () => {
    const r = resolveAuthMode({
      noAuth: true,
      acceptRisk: false,
      host: "127.0.0.1",
      port: 9999,
    })
    expect(r.bindAddress).toBe("127.0.0.1:9999")
  })

  test("bindAddress wraps IPv6 in brackets (RFC 3986)", () => {
    const r = resolveAuthMode({
      noAuth: true,
      acceptRisk: false,
      host: "::1",
      port: 4141,
    })
    expect(r.bindAddress).toBe("[::1]:4141")
  })

  test("config auth=false on loopback is allowed (no --no-auth needed)", () => {
    const r = resolveAuthMode({
      noAuth: false,
      acceptRisk: false,
      host: "127.0.0.1",
      port: 4141,
      configAuth: false,
    })
    expect(r.authEnabled).toBe(false)
    expect(r.label).toBe("off (loopback)")
  })

  test("config auth=false on non-loopback WITHOUT ack: throws with config-specific message", () => {
    expect(() =>
      resolveAuthMode({
        noAuth: false,
        acceptRisk: false,
        host: "0.0.0.0",
        port: 4141,
        configAuth: false,
      }),
    ).toThrow(/features\.auth=false/)
  })

  test("config auth=true with --no-auth: --no-auth wins (off)", () => {
    const r = resolveAuthMode({
      noAuth: true,
      acceptRisk: false,
      host: "127.0.0.1",
      port: 4141,
      configAuth: true,
    })
    expect(r.authEnabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// logAuthModeBanner (smoke test — does not crash on any label)
// ---------------------------------------------------------------------------

describe("logAuthModeBanner", () => {
  test("handles all three label variants without throwing", () => {
    expect(() =>
      logAuthModeBanner({
        authEnabled: true,
        label: "on",
        bindAddress: "127.0.0.1:4141",
      }),
    ).not.toThrow()
    expect(() =>
      logAuthModeBanner({
        authEnabled: false,
        label: "off (loopback)",
        bindAddress: "127.0.0.1:4141",
      }),
    ).not.toThrow()
    expect(() =>
      logAuthModeBanner({
        authEnabled: false,
        label: "off (acknowledged risk)",
        bindAddress: "0.0.0.0:4141",
      }),
    ).not.toThrow()
  })
})
