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

  test("rejects non-loopback addresses", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false)
    expect(isLoopbackHost("192.168.1.1")).toBe(false)
    expect(isLoopbackHost("10.0.0.5")).toBe(false)
    expect(isLoopbackHost("::")).toBe(false)
    expect(isLoopbackHost("example.com")).toBe(false)
    expect(isLoopbackHost("")).toBe(false)
  })

  test("rejects look-alike IPv4 addresses", () => {
    // 128.x.x.x is not loopback
    expect(isLoopbackHost("128.0.0.1")).toBe(false)
    // 126.x.x.x is not loopback
    expect(isLoopbackHost("126.0.0.1")).toBe(false)
    // out-of-range octets are not loopback
    expect(isLoopbackHost("127.0.0.999")).toBe(false)
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

  test("bindAddress includes host and port", () => {
    const r = resolveAuthMode({
      noAuth: true,
      acceptRisk: false,
      host: "127.0.0.1",
      port: 9999,
    })
    expect(r.bindAddress).toBe("127.0.0.1:9999")
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
