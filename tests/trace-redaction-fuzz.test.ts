import { describe, expect, test } from "bun:test"

import {
  assertRedacted,
  BODY_PATTERNS,
  REDACTED_HEADERS,
  redactBody,
  redactHeaders,
} from "../src/services/trace-redact"

// ---------------------------------------------------------------------------
// Header redaction — direct cases
// ---------------------------------------------------------------------------

describe("redactHeaders", () => {
  test("strips Authorization regardless of casing", () => {
    const out = redactHeaders({
      Authorization: "Bearer ghp_realtokenvalue1234567890",
      "Content-Type": "application/json",
    })
    expect(out["authorization"]).toBe("[REDACTED]")
    expect(out["content-type"]).toBe("application/json")
  })

  test("strips every header in REDACTED_HEADERS (Headers instance)", () => {
    const h = new Headers()
    for (const name of REDACTED_HEADERS) h.set(name, "secret-value")
    h.set("x-other", "ok")
    const out = redactHeaders(h)
    for (const name of REDACTED_HEADERS) {
      expect(out[name]).toBe("[REDACTED]")
    }
    expect(out["x-other"]).toBe("ok")
  })

  test("lowercases keys in the output", () => {
    const out = redactHeaders({ "X-Custom-Header": "v" })
    expect(out["x-custom-header"]).toBe("v")
  })
})

// ---------------------------------------------------------------------------
// Body redaction — direct cases
// ---------------------------------------------------------------------------

describe("redactBody", () => {
  test("scrubs gh_ tokens (classic + new prefixes)", () => {
    const sample =
      "tokens: ghp_aaaaaaaaaaaaaaaaaaaa gho_bbbbbbbbbbbbbbbbbbbb ghs_cccccccccccccccccccc ghr_dddddddddddddddddddd ghu_eeeeeeeeeeeeeeeeeeee"
    const out = redactBody(sample)
    expect(out).not.toContain("ghp_")
    expect(out).not.toContain("gho_")
    expect(out).not.toContain("ghs_")
    expect(out).not.toContain("ghr_")
    expect(out).not.toContain("ghu_")
    expect(out.split("[REDACTED]")).toHaveLength(6)
  })

  test("scrubs fine-grained github_pat_", () => {
    const sample =
      "k=github_pat_11AAAAAA_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const out = redactBody(sample)
    expect(out).not.toContain("github_pat_")
  })

  test("scrubs JWT-shaped strings", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    const out = redactBody(`{"copilot_token":"${jwt}"}`)
    expect(out).not.toContain("eyJ")
  })

  test("scrubs Iv1.<hex16> client id literal", () => {
    const out = redactBody("client=Iv1.b507a08c87ecfe98")
    expect(out).toBe("client=[REDACTED]")
  })

  test("scrubs Iv23.<hex16+> client id (new GitHub App family)", () => {
    // crew review R6: the original Iv1 regex was too narrow.
    const out = redactBody("client=Iv23.AbCdEf0123456789Ab")
    expect(out).toBe("client=[REDACTED]")
  })

  test("scrubs this proxy's own sk-cap-* bearer tokens (crew R1)", () => {
    // The proxy mints these as admin/client API keys; a developer pasting
    // their own key into a chat prompt would leak it without this pattern.
    const sample =
      "Here is my key: sk-cap-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Help?"
    const out = redactBody(sample)
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain("sk-cap-A")
  })

  test("scrubs sk-ant-* Anthropic keys", () => {
    const out = redactBody(
      "key=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain("sk-ant-")
  })

  test("scrubs OpenAI-style sk-proj-* keys", () => {
    const out = redactBody(
      "key=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain("sk-proj-")
  })

  test("scrubs AWS access key id (AKIA...)", () => {
    const out = redactBody("aws_access_key=AKIAIOSFODNN7EXAMPLE more text")
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain("AKIA")
  })

  test("scrubs basic-auth credentials embedded in a URL", () => {
    const out = redactBody("https://alice:hunter2supersecret@example.com/path")
    expect(out).toContain("[REDACTED]@example.com")
    expect(out).not.toContain("hunter2supersecret")
  })

  test("returns empty string for null / undefined", () => {
    expect(redactBody(null)).toBe("")
    expect(redactBody(undefined)).toBe("")
  })

  test("JSON-stringifies non-string inputs (no pretty-print)", () => {
    const out = redactBody({ a: 1, b: [1, 2] })
    // single-line JSON.stringify output, not the pretty-printed form
    expect(out).toBe(`{"a":1,"b":[1,2]}`)
    expect(out).not.toContain("\n")
  })
})

// ---------------------------------------------------------------------------
// Property / fuzz tests — generate inputs containing each pattern shape and
// assert NONE of the post-redact patterns match.
// ---------------------------------------------------------------------------

const BASE64_URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const BASE64_NO_UNDERSCORE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const HEX_ALPHABET = "0123456789abcdef"

function rngString(alphabet: string, n: number, rand: () => number): string {
  let s = ""
  for (let i = 0; i < n; i++) {
    s += alphabet[Math.floor(rand() * alphabet.length)]
  }
  return s
}

/** Deterministic PRNG so test reruns produce the same sequence. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return (): number => {
    t = (t + 0x6d_2b_79_f5) >>> 0
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296
  }
}

function makeGhToken(rand: () => number): string {
  const prefixes = ["ghp_", "gho_", "ghs_", "ghr_", "ghu_"]
  const prefix = prefixes[Math.floor(rand() * prefixes.length)]
  // 30+ chars of alphanumerics (no underscore inside the token body)
  const len = 30 + Math.floor(rand() * 20)
  return prefix + rngString(BASE64_NO_UNDERSCORE, len, rand)
}

function makeGithubPat(rand: () => number): string {
  const len = 30 + Math.floor(rand() * 30)
  return (
    "github_pat_"
    + rngString(BASE64_URL_ALPHABET.replaceAll("-", ""), len, rand)
  )
}

function makeJwt(rand: () => number): string {
  const seg = (): string =>
    rngString(BASE64_URL_ALPHABET, 20 + Math.floor(rand() * 40), rand)
  return `eyJ${seg()}.eyJ${seg()}.${seg()}`
}

function makeIv1(rand: () => number): string {
  return `Iv1.${rngString(HEX_ALPHABET, 16, rand)}`
}

const MAKERS = [makeGhToken, makeGithubPat, makeJwt, makeIv1]

function makeRandomLine(rand: () => number): string {
  // Sprinkle 1–4 secrets into a JSON-shaped envelope with some surrounding
  // junk text. We use JSON.stringify so escaped quotes don't break the regex.
  const n = 1 + Math.floor(rand() * 4)
  const parts: Array<string> = []
  for (let i = 0; i < n; i++) {
    const maker = MAKERS[Math.floor(rand() * MAKERS.length)]
    parts.push(maker(rand))
  }
  const payload = {
    note: "random " + rngString(BASE64_NO_UNDERSCORE, 16, rand),
    secrets: parts,
    extra: { padding: rngString(BASE64_NO_UNDERSCORE, 32, rand) },
  }
  return JSON.stringify(payload)
}

describe("redactBody — fuzz", () => {
  test("1000 random inputs: no BODY_PATTERN matches survive redaction", () => {
    const rand = mulberry32(0x42_42_42_42)
    for (let i = 0; i < 1000; i++) {
      const input = makeRandomLine(rand)
      const out = redactBody(input)
      for (const pattern of BODY_PATTERNS) {
        const re = new RegExp(pattern.source, pattern.flags)
        const match = re.exec(out)
        if (match) {
          throw new Error(
            `Pattern /${pattern.source}/ matched "${match[0]}" in redacted output (input: ${input.slice(0, 200)})`,
          )
        }
      }
    }
  })

  test("assertRedacted is a no-op on already-redacted output", () => {
    const rand = mulberry32(0x13_57_9b_df)
    for (let i = 0; i < 50; i++) {
      const out = redactBody(makeRandomLine(rand))
      expect(() => {
        assertRedacted(out)
      }).not.toThrow()
    }
  })

  test("assertRedacted throws when a secret escaped redaction", () => {
    // We can't easily produce a real escape, so feed it raw input that
    // would have been redacted — that's exactly the contract: any matching
    // shape in the OUTPUT must throw.
    expect(() => {
      assertRedacted(`note: ghp_aaaaaaaaaaaaaaaaaaaa`)
    }).toThrow()
    expect(() => {
      assertRedacted(`payload: Iv1.b507a08c87ecfe98`)
    }).toThrow()
  })

  test("assertRedacted catches unknown secret shapes via heuristics (R2)", () => {
    // The bearer-token heuristic catches an opaque token that ISN'T in
    // BODY_PATTERNS — this is the real defence-in-depth value of the
    // post-redact pass.
    expect(() => {
      assertRedacted(
        `Authorization: Bearer some-very-long-opaque-token-of-unknown-issuer-AAAAAAAA`,
      )
    }).toThrow(/credential marker/)
    // token= / api_key= / secret= heuristic
    expect(() => {
      assertRedacted(
        `payload: api_key=very_long_opaque_value_AAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      )
    }).toThrow(/credential marker/)
  })

  test("assertRedacted does NOT throw on natural-language content with token-like words", () => {
    // Claude thinking blocks routinely contain free-text reasoning that
    // mentions "token", "secret", or "password" as English words, plus
    // model-emitted JSON snippets with quoted keys. Previously the
    // post-redact heuristic matched `\b(token|secret|...)["':=]+ <opaque>`
    // anywhere and threw, dropping the entire trace. The tightened heuristic
    // requires an HTTP-header context or unquoted form-data shape, so the
    // following must all pass through cleanly.
    const benignSamples = [
      "the JWT token: eyJzdWIiOiJleGFtcGxlLW5hbWUifQ-thisIsNotARealOne",
      "the model emitted: {\"api_key\":\"this is just a string in JSON content\"}",
      "the user asked about the secret to good code: simplicity-thats-it-AAAAAAAAA",
      `<thinking>The password field is rendered as a string of asterisks like AAAAAAAAAAAAAAAA</thinking>`,
      `the bearer of bad news: this is what users hear after deploying-broken-code-aaa`,
    ]
    for (const s of benignSamples) {
      expect(() => assertRedacted(s)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Defence-in-depth: assertRedacted output of redactBody is always clean
// (this overlaps the fuzz test but pins the contract for human readers).
// ---------------------------------------------------------------------------

describe("redactBody + assertRedacted contract", () => {
  test("known input round-trip", () => {
    const input =
      "Authorization: Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
      + "client=Iv1.0123456789abcdef\n"
      + "copilot=eyJzdWIiOiJ4In0.eyJhbGciOiJSUzI1NiJ9.signaturepart"
    const out = redactBody(input)
    expect(() => {
      assertRedacted(out)
    }).not.toThrow()
    // and the placeholders are present
    expect((out.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
