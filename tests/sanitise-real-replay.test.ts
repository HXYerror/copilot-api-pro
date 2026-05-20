/**
 * 真实回放测试：用从 trace a5c7f0d0（00:44 实际 400 失败）里抽出来的 20 条
 * messages 子集跑 sanitiseMessages，断言 8 个空 text block 全被剥掉，且关键
 * 配对（assistant 的 tool_use ↔ 下一个 user 的 tool_result）保持不变。
 *
 * 失败时把对比结果打到日志，方便看哪条没清理掉。
 */

import { describe, expect, test } from "bun:test"
import fs from "node:fs"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { buildUpstreamPayload } from "~/services/copilot/create-messages-native"

const FIXTURE = "/tmp/copilot-debug/real-payload-msgs.json"

describe("buildUpstreamPayload — real Vertex 400 replay", () => {
  test("strips all 8 empty assistant text blocks from real trace a5c7f0d0 subset", () => {
    if (!fs.existsSync(FIXTURE)) {
      console.warn(
        `Fixture missing at ${FIXTURE} — skipping replay test (run extraction script first)`,
      )
      return
    }
    const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as {
      messages: AnthropicMessagesPayload["messages"]
    }

    // Count empties going in
    let emptiesIn = 0
    for (const m of raw.messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "text" && b.text === "") emptiesIn++
        }
      }
    }
    expect(emptiesIn).toBeGreaterThan(0)
    console.log(`[replay] inbound empty text blocks: ${emptiesIn}`)

    const out = buildUpstreamPayload({
      model: "claude-opus-4.7",
      max_tokens: 1024,
      messages: raw.messages,
    })

    // Count empties going out
    let emptiesOut = 0
    const emptyLocations: Array<string> = []
    for (const [i, m] of out.messages.entries()) {
      if (Array.isArray(m.content)) {
        for (const [j, b] of m.content.entries()) {
          if (b.type === "text" && b.text === "") {
            emptiesOut++
            emptyLocations.push(`[${i}][${j}] role=${m.role}`)
          }
        }
      }
    }
    console.log(`[replay] post-sanitise empty text blocks: ${emptiesOut}`)
    if (emptiesOut > 0) {
      console.log(`[replay] remaining empties at: ${emptyLocations.join(", ")}`)
    }

    expect(emptiesOut).toBe(0)

    // Verify tool_use/tool_result pairing preserved — count tool_use ids in
    // assistant messages, then count matching tool_use_ids in user messages.
    const toolUseIds = new Set<string>()
    const toolResultIds = new Set<string>()
    for (const m of out.messages) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) {
        if (b.type === "tool_use") toolUseIds.add(b.id)
        if (b.type === "tool_result") toolResultIds.add(b.tool_use_id)
      }
    }
    console.log(
      `[replay] tool_use count=${toolUseIds.size}, tool_result count=${toolResultIds.size}`,
    )
    // Every tool_use should have a corresponding tool_result (the inbound
    // satisfied this; sanitiseMessages must preserve it).
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true)
    }
  })
})
