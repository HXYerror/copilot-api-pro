#!/usr/bin/env python3
"""
test_models.py — 通过 copilot-api 调用所有上游模型的健康检查脚本

流程：
  1. GET  /v1/models           拉取当前 copilot-api 暴露的模型清单
  2. 按 model id 分流：
       - text-embedding-*     → /v1/embeddings        (向量)
       - claude-*             → /v1/messages          (Anthropic 格式)
       - *codex* | o\\d+-pro   → /v1/responses         (Responses API)
       - 其它                 → /v1/chat/completions  (OpenAI 兼容)
  3. 每个模型发一次小流量请求，验证可用性。
  4. 输出按状态分组的汇总表。

用法：
  COPILOT_API_KEY=sk-cap-XXXX python3 test_models.py
  COPILOT_API_KEY=sk-cap-XXXX python3 test_models.py --base http://127.0.0.1:4141
  COPILOT_API_KEY=sk-cap-XXXX python3 test_models.py --only gpt-4o,claude-sonnet-4.5
  COPILOT_API_KEY=sk-cap-XXXX python3 test_models.py --skip gpt-3.5-turbo,gpt-4
  COPILOT_API_KEY=sk-cap-XXXX python3 test_models.py --timeout 60

说明：
  - 每个模型只发一次请求；失败时打印 HTTP 状态码 + 服务器返回的 error 字段。
  - 使用多样化的 prompt 覆盖代码/翻译/数学/JSON/总结等场景。
  - 嵌入模型用独立的短输入测试。
  - 不强制 max_tokens / temperature —— 让模型自己决定回复长度，避免人为限制
    干扰真实可用性判断。
  - 不依赖 OpenAI SDK / anthropic SDK，仅用标准库。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

# ----------------------------------------------------------------------------
# Prompt scenarios — kept tiny so each round-trip stays cheap.
# ----------------------------------------------------------------------------

CHAT_SCENARIOS: list[dict[str, str]] = [
    {
        "name": "code-review",
        "system": "You are a senior code reviewer. Reply in one short sentence.",
        "user": "Spot the bug: `def add(a,b): return a-b`",
    },
    {
        "name": "math",
        "system": "You are a precise math tutor. Reply with only the number.",
        "user": "What is 17 * 23?",
    },
    {
        "name": "translate-zh",
        "system": "You are a translator. Output only the translation.",
        "user": 'Translate to Chinese: "The quick brown fox jumps over the lazy dog."',
    },
    {
        "name": "summarize",
        "system": "Summarize in one sentence.",
        "user": (
            "GitHub Copilot is an AI pair-programmer that suggests code "
            "completions inline as you type, trained on public source code."
        ),
    },
    {
        "name": "json-output",
        "system": "Reply ONLY with valid JSON, no prose.",
        "user": 'Return {"hello":"world"} as JSON.',
    },
    {
        "name": "shell-howto",
        "system": "You are a CLI expert. Reply with one shell command, nothing else.",
        "user": "How do I list all files modified in the last 24 hours under the current directory?",
    },
    {
        "name": "regex",
        "system": "Reply with one regex, no explanation.",
        "user": "Write a regex matching IPv4 dotted-decimal addresses.",
    },
    {
        "name": "explain",
        "system": "Reply with one short sentence.",
        "user": "What is a 'monad' in functional programming?",
    },
]

EMBED_INPUT = "copilot-api smoke test embedding input"

# Models that are clearly not chat-able. If we hit any of these we skip.
KNOWN_NON_CHAT_PATTERNS = [
    re.compile(r"^text-embedding"),
    # Routers / dispatchers — these are upstream-internal aliases
    re.compile(r"^accounts/.*/routers/"),
]

# ----------------------------------------------------------------------------
# Routing helpers — mirror src/lib/model-routing.ts
# ----------------------------------------------------------------------------

RESPONSES_ONLY_PATTERNS = [
    re.compile(r"(?:^|-)codex(?:-|$)"),
    re.compile(r"^o\d+-pro(?:-\d{4}-\d{2}-\d{2})?$"),
]


def is_responses_only(model_id: str) -> bool:
    return any(p.search(model_id) for p in RESPONSES_ONLY_PATTERNS)


def is_embedding(model_id: str) -> bool:
    return model_id.startswith("text-embedding")


def is_claude(model_id: str) -> bool:
    return model_id.startswith("claude")


def is_skipworthy(model_id: str) -> bool:
    return any(p.search(model_id) for p in KNOWN_NON_CHAT_PATTERNS[1:])  # routers only


# ----------------------------------------------------------------------------
# Minimal HTTP wrapper
# ----------------------------------------------------------------------------


@dataclass
class HTTPResult:
    status: int
    body: Any
    elapsed_ms: int
    error: str | None = None


def http_post(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout: float,
) -> HTTPResult:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            elapsed = int((time.monotonic() - start) * 1000)
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = raw
            return HTTPResult(status=resp.status, body=parsed, elapsed_ms=elapsed)
    except urllib.error.HTTPError as e:
        elapsed = int((time.monotonic() - start) * 1000)
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        return HTTPResult(
            status=e.code,
            body=parsed,
            elapsed_ms=elapsed,
            error=f"HTTP {e.code}",
        )
    except urllib.error.URLError as e:
        elapsed = int((time.monotonic() - start) * 1000)
        return HTTPResult(status=0, body=None, elapsed_ms=elapsed, error=str(e.reason))
    except TimeoutError:
        elapsed = int((time.monotonic() - start) * 1000)
        return HTTPResult(status=0, body=None, elapsed_ms=elapsed, error="timeout")
    except OSError as e:
        elapsed = int((time.monotonic() - start) * 1000)
        return HTTPResult(status=0, body=None, elapsed_ms=elapsed, error=str(e))


def http_get(
    url: str,
    headers: dict[str, str],
    timeout: float,
) -> HTTPResult:
    req = urllib.request.Request(url, headers=headers, method="GET")
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            elapsed = int((time.monotonic() - start) * 1000)
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = raw
            return HTTPResult(status=resp.status, body=parsed, elapsed_ms=elapsed)
    except urllib.error.HTTPError as e:
        elapsed = int((time.monotonic() - start) * 1000)
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        return HTTPResult(
            status=e.code, body=parsed, elapsed_ms=elapsed, error=f"HTTP {e.code}"
        )
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        elapsed = int((time.monotonic() - start) * 1000)
        return HTTPResult(status=0, body=None, elapsed_ms=elapsed, error=str(e))


# ----------------------------------------------------------------------------
# Endpoint adapters — each returns (endpoint_label, request_body, success_check)
# ----------------------------------------------------------------------------


def build_chat_body(model: str, scenario: dict[str, str]) -> dict[str, Any]:
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": scenario["system"]},
            {"role": "user", "content": scenario["user"]},
        ],
        "stream": False,
    }


def build_anthropic_body(model: str, scenario: dict[str, str]) -> dict[str, Any]:
    # Anthropic /v1/messages requires `max_tokens` — pick a generous cap so we
    # don't artificially throttle the response. The actual reply may be much
    # shorter; this is the upper bound the model can produce.
    return {
        "model": model,
        "system": scenario["system"],
        "messages": [
            {"role": "user", "content": scenario["user"]},
        ],
        "max_tokens": 4096,
        "stream": False,
    }


def build_responses_body(model: str, scenario: dict[str, str]) -> dict[str, Any]:
    # Responses API: single `input` string (no system / messages array).
    return {
        "model": model,
        "input": f"{scenario['system']}\n\n{scenario['user']}",
        "stream": False,
    }


def build_embed_body(model: str) -> dict[str, Any]:
    return {"model": model, "input": EMBED_INPUT}


# ----------------------------------------------------------------------------
# Success checks — read the response body and decide whether the call worked.
# ----------------------------------------------------------------------------


def extract_chat_completion(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    choices = body.get("choices") or []
    if not choices:
        return None
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    return None


def extract_anthropic_text(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    content = body.get("content") or []
    if not content:
        return None
    parts: list[str] = []
    for blk in content:
        if isinstance(blk, dict) and blk.get("type") == "text":
            t = blk.get("text")
            if isinstance(t, str):
                parts.append(t)
    out = "".join(parts).strip()
    return out if out else None


def extract_responses_text(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    # New OpenAI Responses shape: output[].content[].text
    output = body.get("output") or []
    if output:
        parts: list[str] = []
        for item in output:
            for blk in item.get("content", []) or []:
                if isinstance(blk, dict) and blk.get("type") in ("output_text", "text"):
                    t = blk.get("text")
                    if isinstance(t, str):
                        parts.append(t)
        out = "".join(parts).strip()
        if out:
            return out
    # Fallback shapes
    if isinstance(body.get("output_text"), str):
        return body["output_text"].strip() or None
    return None


def extract_embed_len(body: Any) -> int | None:
    if not isinstance(body, dict):
        return None
    data = body.get("data") or []
    if not data:
        return None
    emb = data[0].get("embedding")
    if isinstance(emb, list):
        return len(emb)
    return None


# ----------------------------------------------------------------------------
# Per-model probe
# ----------------------------------------------------------------------------


@dataclass
class ProbeOutcome:
    model: str
    endpoint: str
    scenario: str
    status: int
    ok: bool
    elapsed_ms: int
    note: str = ""
    error: str | None = None


def probe_model(
    base_url: str,
    api_key: str,
    model: str,
    scenario_idx: int,
    timeout: float,
) -> ProbeOutcome:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "copilot-api-test-models/1.0",
    }

    # Embeddings
    if is_embedding(model):
        url = f"{base_url}/v1/embeddings"
        body = build_embed_body(model)
        r = http_post(url, headers, body, timeout)
        ok = r.status == 200 and extract_embed_len(r.body) is not None
        note = f"dim={extract_embed_len(r.body)}" if ok else _err_note(r)
        return ProbeOutcome(
            model=model,
            endpoint="embeddings",
            scenario="embed",
            status=r.status,
            ok=ok,
            elapsed_ms=r.elapsed_ms,
            note=note,
            error=r.error,
        )

    scenario = CHAT_SCENARIOS[scenario_idx % len(CHAT_SCENARIOS)]

    # Anthropic Messages API for Claude
    if is_claude(model):
        url = f"{base_url}/v1/messages"
        headers_anthropic = {
            **headers,
            "anthropic-version": "2023-06-01",
        }
        body = build_anthropic_body(model, scenario)
        r = http_post(url, headers_anthropic, body, timeout)
        text = extract_anthropic_text(r.body) if r.status == 200 else None
        ok = bool(text)
        note = _truncate(text) if text else _err_note(r)
        return ProbeOutcome(
            model=model,
            endpoint="messages",
            scenario=scenario["name"],
            status=r.status,
            ok=ok,
            elapsed_ms=r.elapsed_ms,
            note=note,
            error=r.error,
        )

    # Responses API for codex / o-pro
    if is_responses_only(model):
        url = f"{base_url}/v1/responses"
        body = build_responses_body(model, scenario)
        r = http_post(url, headers, body, timeout)
        text = extract_responses_text(r.body) if r.status == 200 else None
        ok = bool(text)
        note = _truncate(text) if text else _err_note(r)
        return ProbeOutcome(
            model=model,
            endpoint="responses",
            scenario=scenario["name"],
            status=r.status,
            ok=ok,
            elapsed_ms=r.elapsed_ms,
            note=note,
            error=r.error,
        )

    # Default: Chat Completions
    url = f"{base_url}/v1/chat/completions"
    body = build_chat_body(model, scenario)
    r = http_post(url, headers, body, timeout)
    text = extract_chat_completion(r.body) if r.status == 200 else None
    ok = bool(text)

    # Upstream Copilot's `capabilities.type` is sometimes wrong: a model
    # advertised as `type: chat` may actually require `/v1/responses`
    # (observed on gpt-5.x — the upstream rejects /chat/completions with
    # "model X is not accessible via the /chat/completions endpoint").
    # Auto-fall-back to /v1/responses when we see that signature.
    if not ok and r.status == 400 and _smells_like_responses_only(r.body):
        url2 = f"{base_url}/v1/responses"
        body2 = build_responses_body(model, scenario)
        r2 = http_post(url2, headers, body2, timeout)
        text2 = extract_responses_text(r2.body) if r2.status == 200 else None
        if text2:
            return ProbeOutcome(
                model=model,
                endpoint="responses (fallback)",
                scenario=scenario["name"],
                status=r2.status,
                ok=True,
                elapsed_ms=r.elapsed_ms + r2.elapsed_ms,
                note=_truncate(text2),
                error=None,
            )
        # fallback also failed — report combined info
        return ProbeOutcome(
            model=model,
            endpoint="responses (fallback)",
            scenario=scenario["name"],
            status=r2.status,
            ok=False,
            elapsed_ms=r.elapsed_ms + r2.elapsed_ms,
            note=_err_note(r2),
            error=r2.error,
        )

    note = _truncate(text) if text else _err_note(r)
    return ProbeOutcome(
        model=model,
        endpoint="chat/completions",
        scenario=scenario["name"],
        status=r.status,
        ok=ok,
        elapsed_ms=r.elapsed_ms,
        note=note,
        error=r.error,
    )


def _smells_like_responses_only(body: Any) -> bool:
    """Heuristic for 'model needs /v1/responses, not /chat/completions'."""
    if not isinstance(body, dict):
        return False
    err = body.get("error")
    if isinstance(err, dict):
        msg = err.get("message", "")
    elif isinstance(err, str):
        msg = err
    else:
        msg = ""
    msg_l = str(msg).lower()
    return (
        "/responses" in msg_l
        or "/chat/completions endpoint" in msg_l
        or "not accessible via" in msg_l
    )


def _truncate(text: str | None, n: int = 80) -> str:
    if not text:
        return ""
    flat = " ".join(text.split())
    return flat if len(flat) <= n else flat[: n - 1] + "…"


def _err_note(r: HTTPResult) -> str:
    if isinstance(r.body, dict):
        for k in ("error", "message", "detail"):
            v = r.body.get(k)
            if isinstance(v, dict):
                m = v.get("message") or v.get("error") or json.dumps(v)
                return _truncate(str(m), 100)
            if isinstance(v, str) and v:
                return _truncate(v, 100)
        return _truncate(json.dumps(r.body), 100)
    if isinstance(r.body, str) and r.body:
        return _truncate(r.body, 100)
    return r.error or "no response body"


# ----------------------------------------------------------------------------
# Main flow
# ----------------------------------------------------------------------------


def fetch_models(base_url: str, api_key: str, timeout: float) -> list[str]:
    url = f"{base_url}/v1/models"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": "copilot-api-test-models/1.0",
    }
    r = http_get(url, headers, timeout)
    if r.status != 200:
        raise SystemExit(
            f"failed to fetch /v1/models from {url}: status={r.status} err={_err_note(r)}"
        )
    if not isinstance(r.body, dict):
        raise SystemExit(f"unexpected /v1/models payload: {r.body!r}")
    data = r.body.get("data") or []
    ids = [m.get("id") for m in data if isinstance(m, dict) and m.get("id")]
    if not ids:
        raise SystemExit("no models found in /v1/models response")
    return sorted(set(ids))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Probe every model exposed by a copilot-api instance.",
    )
    parser.add_argument(
        "--base",
        default=os.environ.get("COPILOT_API_BASE", "http://127.0.0.1:4141"),
        help="copilot-api base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--key",
        default=os.environ.get("COPILOT_API_KEY"),
        help="API key (env COPILOT_API_KEY). Required.",
    )
    parser.add_argument(
        "--only",
        default="",
        help="Comma-separated model ids to test (default: all from /v1/models).",
    )
    parser.add_argument(
        "--skip",
        default="",
        help="Comma-separated model ids to skip.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="HTTP timeout in seconds (default: %(default)s).",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Just print the discovered model list and exit.",
    )
    parser.add_argument(
        "--include-routers",
        action="store_true",
        help="Include accounts/*/routers/* dispatcher entries (skipped by default).",
    )
    args = parser.parse_args()

    if not args.key:
        print(
            "error: --key or COPILOT_API_KEY required (e.g. an sk-cap-… admin/client key)",
            file=sys.stderr,
        )
        return 2

    base_url = args.base.rstrip("/")
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}

    print(f"copilot-api base : {base_url}")
    print(f"discovering /v1/models …")
    models = fetch_models(base_url, args.key, args.timeout)

    # Build the probe list
    probe_list: list[str] = []
    for m in models:
        if only and m not in only:
            continue
        if m in skip:
            continue
        if not args.include_routers and is_skipworthy(m):
            continue
        probe_list.append(m)

    print(f"discovered {len(models)} models, probing {len(probe_list)}")
    if args.list:
        for m in probe_list:
            print(f"  {m}")
        return 0

    print()
    print(f"{'model':40}  {'endpoint':18}  {'scenario':14}  {'ms':>5}  {'status':>6}  note")
    print("-" * 120)

    outcomes: list[ProbeOutcome] = []
    for i, model in enumerate(probe_list):
        out = probe_model(
            base_url=base_url,
            api_key=args.key,
            model=model,
            scenario_idx=i,
            timeout=args.timeout,
        )
        outcomes.append(out)
        flag = "✓" if out.ok else "✗"
        print(
            f"{flag} {out.model:<38}  {out.endpoint:<18}  {out.scenario:<14}  "
            f"{out.elapsed_ms:>5}  {out.status:>6}  {out.note}"
        )

    # Summary
    print()
    print("=" * 120)
    by_status: dict[str, list[ProbeOutcome]] = {}
    for o in outcomes:
        key = "ok" if o.ok else f"fail-{o.status or 'net'}"
        by_status.setdefault(key, []).append(o)
    for k in sorted(by_status):
        rows = by_status[k]
        print(f"{k:<14}  ({len(rows)})")
        for o in rows:
            print(f"  - {o.model}  ({o.endpoint}, {o.elapsed_ms} ms)")
    total = len(outcomes)
    okn = sum(1 for o in outcomes if o.ok)
    print()
    print(f"Total: {okn}/{total} ok")

    return 0 if okn == total else 1


if __name__ == "__main__":
    sys.exit(main())
