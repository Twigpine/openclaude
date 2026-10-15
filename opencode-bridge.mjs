#!/usr/bin/env node
import http from "node:http"
import { spawn } from "node:child_process"
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.OC_BRIDGE_PORT ?? 18095)
const OC_URL = (process.env.OC_BRIDGE_URL ?? "http://127.0.0.1:18085").replace(/\/+$/, "")
const OC_TOKEN = process.env.OC_BRIDGE_TOKEN
const FCC_URL = (process.env.FCC_URL ?? "http://127.0.0.1:8082").replace(/\/+$/, "")
const FCC_TOKEN = (process.env.FCC_TOKEN ?? "").trim()
const FCC_MODEL = process.env.FCC_MODEL ?? "nvidia_nim/nvidia/nemotron-3-super-120b-a12b"
const CLINE_CANDIDATES = process.env.CLINE_CANDIDATES ?? join(HERE, "cline-candidates.txt")
const CLINE_REFRESH_MS = Number(process.env.CLINE_REFRESH_MS ?? 10 * 60 * 1000)

if (!OC_TOKEN) {
  console.error("OC_BRIDGE_TOKEN is required (the server password printed by opencode serve).")
  process.exit(1)
}

const OC_AUTH = "Basic " + Buffer.from("opencode:" + OC_TOKEN).toString("base64")

// ---- HTTP helpers ----
async function oc(method, path, body, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(OC_URL + path, {
      method,
      headers: { Authorization: OC_AUTH, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error("opencode " + res.status + ": " + text.slice(0, 300))
      err.status = res.status
      throw err
    }
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

async function fcc(method, path, body, timeoutMs = 60000) {
  if (!FCC_TOKEN) return { type: "error", error: { type: "authentication_error", message: "FCC_TOKEN not configured (set FCC_TOKEN env var)" } }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(FCC_URL + path, {
      method,
      headers: { "x-api-key": FCC_TOKEN, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error("fcc " + res.status + ": " + text.slice(0, 300))
      err.status = res.status
      throw err
    }
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

// ---- Model catalogs ----
function readClineCandidates() {
  try {
    if (!existsSync(CLINE_CANDIDATES)) return []
    return readFileSync(CLINE_CANDIDATES, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"))
  } catch {
    return []
  }
}

const clineStatus = new Map()

async function probeClineModel(model) {
  const started = Date.now()
  try {
    const { text } = await runClineTurn(model, "Reply with exactly: PONG")
    clineStatus.set(model, {
      state: text ? "available" : "unavailable",
      detail: text ? undefined : "empty reply",
      checkedAt: started,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    clineStatus.set(model, {
      state: "unavailable",
      detail: String(error.message || error).slice(0, 120),
      checkedAt: started,
      latencyMs: Date.now() - started,
    })
  }
}

let clineRefreshPromise = null
function refreshCline() {
  if (clineRefreshPromise) return clineRefreshPromise
  clineRefreshPromise = (async () => {
    const candidates = readClineCandidates()
    for (const candidate of candidates) await probeClineModel(candidate)
    console.log("[cline] " + candidates.length + " candidates probed: " + [...clineStatus.values()].filter(s => s.state === "available").length + " alive")
  })().finally(() => { clineRefreshPromise = null })
  return clineRefreshPromise
}

const CLINE_PREFIXES = ["cline-free/", "stealth/", "cline/"]

function isClineModel(model) {
  return CLINE_PREFIXES.some(p => model.startsWith(p))
}

// FCC-routed models: anything on FCC's "anthropic" surface
// ("anthropic/<provider>/<model...>") — nim, openai chatgpt, custom providers.
// Legacy bare forms (nvidia_nim/..., openai/...) kept for stored model specs.
function isNimModel(model) {
  if (typeof model !== "string") return false
  return model.startsWith("anthropic/") || model.includes("nvidia_nim/") || model.startsWith("openai/")
}

function toOpencodeModel(requested) {
  if (typeof requested !== "string") return "space-bunny-free"
  const bare = requested.includes("/") ? requested.slice(requested.lastIndexOf("/") + 1) : requested
  return bare || "space-bunny-free"
}

// ---- Session management ----
// One session per turn: a reused session goes stale after a failed turn
// (e.g. a 429 from the free tier) and then fails every later request.
// Transient failures are handled by runTurnWithFallback (next model).
async function newSession() {
  try {
    const created = await oc("POST", "/api/session", { title: "bridge new" }, 10000)
    const sid = created.data?.id ?? created.id
    if (!sid) throw new Error("opencode did not return a session id")
    console.log("[session] nouvelle session " + sid.slice(-6))
    return sid
  } catch (e) {
    console.error("[session] échec création: " + (e.message || e))
    throw e
  }
}

async function setModelOnSession(sid, model) {
  try {
    await oc("POST", `/api/session/${sid}/model`, { model: { id: model, providerID: "opencode" } }, 10000)
  } catch { /* keep going */ }
}

// ---- runTurn ----
async function runTurn(model, prompt, maxTokens, directive) {
  if (isClineModel(model)) return runClineTurn(model, prompt)
  if (isNimModel(model)) return runNimTurn(model, prompt, maxTokens)
  // Only opencode turns receive an agent directive — cline/nim have their
  // own harness. `directive` undefined falls back to DIRECTIVE inside.
  return runOpencodeTurn(toOpencodeModel(model), prompt, directive)
}

// Ordered fallback chain (opencode free tier first — fastest — then the
// others). Override with OC_BRIDGE_FALLBACKS="modelA,modelB".
const FALLBACKS = (process.env.OC_BRIDGE_FALLBACKS ??
  "opencode/cat-jam-free,opencode/muse-spark-1.3-contributor-free,opencode/step-5-preview-free,opencode/big-pickle,opencode/space-bunny-free")
  .split(",").map(s => s.trim()).filter(Boolean)

async function runTurnWithFallback(model, prompt, maxTokens, directive) {
  const chain = [model, ...FALLBACKS.filter(m => m !== model)]
    .slice(0, Number(process.env.OC_BRIDGE_MAX_MODELS ?? 3)) // cap wall time
  let last = { error: "no model in fallback chain" }
  for (const m of chain) {
    const t0 = Date.now()
    const reply = await runTurn(m, prompt, maxTokens, directive).catch(err => ({ error: String(err.message || err) }))
    const ms = Date.now() - t0
    if (!reply.error) {
      if (m !== model) console.log("[fallback] " + model + " failed, served by " + m + " in " + ms + "ms")
      return reply
    }
    last = reply
    console.log("[fallback] " + m + " failed after " + ms + "ms: " + String(reply.error).slice(0, 80))
    // A timeout means the prompt itself is heavy (agentic tool turn) — the
    // next model would be just as slow, so fail fast instead of stacking
    // 3 x 180 s. Rate limits, on the other hand, are worth retrying.
    if (String(reply.error).includes("timed out")) break
  }
  return last
}

// opencode's /prompt endpoint is itself agentic (it can read/grep files for
// prompts like "review my project") — its own tools do the work and we
// return the final text. OpenClaude's system prompt confuses free models
// into *announcing* tool calls ("Je vais explorer…") instead of letting
// opencode's agent execute them, so state the contract explicitly.
const DIRECTIVE = "You are the executing agent. Do the work NOW with your own tools (read files, run commands, search) — never just describe what you would do, never ask the user to proceed. STRICT BUDGET: at most 6 tool calls, prefer quick ones (ls, package.json, README.md, git log --oneline -10), then write the final answer immediately. Total: under 60 seconds.\n\nUser request:\n\n"

// Compaction requests (see isCompactionRequest) must NOT be told to run
// tools: the TUI's summary prompt already opens with a no-tools preamble,
// and prefixing DIRECTIVE made opencode launch a 150s tool rampage instead
// of summarizing — the summary never came back, 502'd, and auto-compact
// re-fired on every following message.
const COMPACT_DIRECTIVE = "You are a summarization engine. Reply with ONLY the summary structure requested below — no tool calls, no questions, no preamble, no code, no commentary. Begin directly with the requested format.\n\n"

async function runOpencodeTurn(model, prompt, directive = DIRECTIVE) {
  prompt = directive + prompt
  // One session per request: a reused session goes stale after a failed turn
  // (e.g. a 429 from the free tier) and then fails every later request.
  // Transient failures are handled by runTurnWithFallback (next model).
  const sid = await newSession()
  try {
    await setModelOnSession(sid, model)
    await oc("POST", "/api/session/" + sid + "/prompt", { text: prompt }, 15000)
    return await waitForReply(sid, Number(process.env.OC_BRIDGE_DEADLINE ?? 150000))
  } finally {
    try { await oc("DELETE", "/api/session/" + sid, undefined, 5000) } catch { /* already gone */ }
  }
}

async function runNimTurn(model, prompt, maxTokens) {
  const fccModel = model.startsWith("anthropic/") ? model : `anthropic/${model}`
  const reply = await fcc("POST", "/v1/messages", {
    model: fccModel,
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 4096,
    messages: [{ role: "user", content: prompt }],
  })
  if (reply.type === "error") {
    return { error: reply.error?.message ?? "fcc error" }
  }
  const text = (reply.content ?? [])
    .filter(c => c && c.type === "text")
    .map(c => c.text)
    .join("")
  return { text: text.trim() }
}

// ---- transparent Anthropic proxy for FCC (tool-capable turns) ----
// A request that carries `tools` is a TUI agent turn: the model must be able
// to return real tool_use blocks (id/name/input), get thinking blocks back,
// and receive the tool_result on the next call. Flattening that into a text
// prompt is exactly what made FCC models only "announce" tool calls in prose.
// FCC speaks the Anthropic protocol natively (verified: system blocks with
// cache_control, tool_use -> tool_result round trip, SSE with thinking and
// input_json_delta), so these turns are proxied as-is; only
// usage.input_tokens is rewritten to the bridge's honest request estimate
// (FCC's own count is partial at message_start and inconsistent between
// stream and buffered). Compaction stays on the flattened path (it must
// never call tools) and any proxy failure falls back to it, since nothing
// is written to the client until FCC answers 200.
async function proxyFccTurn(body, model, res, inputTokens) {
  if (!FCC_TOKEN) throw new Error("FCC_TOKEN not configured (set FCC_TOKEN env var)")
  const fccModel = model.startsWith("anthropic/") ? model : `anthropic/${model}`
  let cap = Number(process.env.OC_BRIDGE_MAXTOKENS ?? 4096)
  if (!Number.isFinite(cap) || cap <= 0) cap = 4096
  const payload = { ...body, model: fccModel }
  if (typeof payload.max_tokens !== "number" || payload.max_tokens > cap) payload.max_tokens = cap
  // Anthropic constraint: thinking.budget_tokens must stay below max_tokens.
  const thinking = payload.thinking
  if (thinking && typeof thinking === "object" && Number.isFinite(Number(thinking.budget_tokens)) && Number(thinking.budget_tokens) >= payload.max_tokens) {
    payload.thinking = { ...thinking, budget_tokens: Math.max(1024, Math.floor(payload.max_tokens / 2)) }
  }
  const stream = body.stream !== false
  payload.stream = stream
  const controller = new AbortController()
  const onClose = () => controller.abort()
  res.on("close", onClose)
  const timer = setTimeout(() => controller.abort(), Number(process.env.OC_BRIDGE_DEADLINE ?? 150000))
  try {
    const r = await fetch(FCC_URL + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": FCC_TOKEN, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!r.ok) {
      const text = await r.text().catch(() => "")
      throw new Error("fcc " + r.status + ": " + text.slice(0, 300))
    }
    if (!stream) {
      const reply = JSON.parse(await r.text())
      reply.model = model
      if (reply.usage) {
        reply.usage = {
          input_tokens: Math.max(1, inputTokens | 0),
          output_tokens: reply.usage.output_tokens ?? 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }
      }
      console.log("[fcc] proxy buffered 200 " + model)
      return send(res, 200, reply)
    }
    // Pipe the SSE frames through untouched except for usage bookkeeping.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" })
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        res.write(rewriteProxyFrame(frame, model, inputTokens))
      }
    }
    if (buf.trim()) res.write(rewriteProxyFrame(buf, model, inputTokens))
    res.end()
    console.log("[fcc] proxy stream 200 " + model)
  } finally {
    clearTimeout(timer)
    res.off("close", onClose)
  }
}

// Pass an FCC SSE frame through, rewriting only usage bookkeeping:
// input_tokens = honest estimate of the client's request, cache = 0.
// Everything else (thinking/text/tool_use blocks, input_json_delta,
// stop_reason) flows verbatim so the TUI can run its own tool loop.
function rewriteProxyFrame(frame, model, inputTokens) {
  const lines = frame.split("\n")
  let event = null
  let dataIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("event: ")) event = lines[i].slice(7).trim()
    else if (lines[i].startsWith("data: ") && dataIdx === -1) dataIdx = i
  }
  if (dataIdx === -1) return frame + "\n\n"
  let data
  try { data = JSON.parse(lines[dataIdx].slice(6)) } catch { return frame + "\n\n" }
  const estimate = Math.max(1, inputTokens | 0)
  if (data?.type === "message_start" && data.message) {
    data.message.model = model
    data.message.usage = { input_tokens: estimate, output_tokens: 0 }
  } else if (data?.type === "message_delta" && data.usage) {
    data.usage = { input_tokens: estimate, output_tokens: data.usage.output_tokens ?? 0 }
  } else {
    return frame + "\n\n"
  }
  return "event: " + (event || data.type) + "\ndata: " + JSON.stringify(data) + "\n\n"
}

const CLINE_TIMEOUT_MS = 150000

async function runClineTurn(model, prompt) {
  const message = prompt.trim().includes(" ") ? prompt : `${prompt.trim()} .`
  const proc = spawn("cline", [message, "--json", "--auto-approve", "false", "-m", model], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })
  let stdout = ""
  let stderr = ""
  proc.stdout.on("data", c => { stdout += c })
  proc.stderr.on("data", c => { stderr += c })
  const timer = setTimeout(() => proc.kill("SIGTERM"), CLINE_TIMEOUT_MS)
  const code = await new Promise(resolve => {
    proc.on("close", resolve)
    proc.on("error", () => resolve(-1))
  })
  clearTimeout(timer)
  if (code === -1) return { error: "failed to spawn cline" }
  if (code !== 0) {
    console.error("[cline] exited " + code + ": " + (stderr || stdout).slice(0, 500))
    return { error: "cline exited with status " + code }
  }
  return { text: parseClineText(stdout) }
}

function parseClineText(stdout) {
  let text = ""
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type !== "agent_event") continue
    const ev = obj.event ?? {}
    if (ev.type !== "content_start" || ev.contentType !== "text") continue
    if (typeof ev.accumulated === "string") text = ev.accumulated
    else if (typeof ev.text === "string") text += ev.text
  }
  return text.trim()
}

// ---- waitForReply ----
async function waitForReply(sid, deadlineMs = Number(process.env.OC_BRIDGE_DEADLINE ?? 150000)) {
  const started = Date.now()
  let sawAssistant = false
  let finishedText = null
  let finalText = null
  let polls = 0
  let pollErrors = 0
  while (Date.now() - started < deadlineMs) {
    await new Promise(r => setTimeout(r, 120))
    polls++
    let data
    try {
      data = await oc("GET", "/api/session/" + sid + "/message", undefined, 10000)
    } catch {
      pollErrors++
      continue
    }
    // Pass 1: track assistant progress. opencode lists the assistant
    // message before its text has streamed in, and sets `finish`
    // separately, so we accumulate text but never return "no reply"
    // from a finish+empty sighting — that was causing false failures.
    for (const m of data.data ?? []) {
      if (m.type !== "assistant") continue
      sawAssistant = true
      if (m.error) return { error: m.error.message ?? String(m.error) }
      if (m.finish === "error") return { error: "generation failed" }
      const text = (m.content ?? [])
        .filter(c => c && c.type === "text")
        .map(c => c.text)
        .join("")
      // Messages arrive NEWEST-FIRST. Prefer the message marked finish=stop
      // (the real final answer); announcements have finish=tool-calls.
      if (text.trim()) {
        if (m.finish === "stop" && !finalText) finalText = text
        if (!finishedText) finishedText = text
      }
    }
    // Pass 2: idle event is the authoritative turn-completion signal.
    for (const m of data.data ?? []) {
      if (m.type !== "idle") continue
      const outcome = m.outcome ?? "unknown"
      if (outcome === "failed") {
        return { error: m.error?.message ? String(m.error.message) : "opencode turn failed (outcome: failed)" }
      }
      if (outcome === "succeeded" || outcome === "completed") {
        if (finalText && finalText.trim()) return { text: finalText }
        if (finishedText && finishedText.trim()) return { text: finishedText }
        return { error: "opencode turn completed without a reply" }
      }
    }
  }
  console.log("[poll] timed out after " + polls + " polls, " + pollErrors + " errors (partial text kept)")
  // Deadline hit but the agent made progress: opencode returns messages
  // NEWEST-FIRST, so finishedText is the latest real content. Hand it back
  // rather than erroring — a retry would restart the exploration from zero.
  if (finalText && finalText.trim()) return { text: finalText }
  if (finishedText && finishedText.trim()) return { text: finishedText }
  return { error: "bridge timed out after " + deadlineMs + "ms waiting for a reply" }
}

// ---- opencode event bus (/api/event, live SSE) ----
// The message polling endpoint only reveals text AFTER a step completes, so
// polling can never show thinking or token usage live. /api/event streams
// session.reasoning.delta, session.text.delta and session.usage.updated as
// they happen. One persistent connection, dispatched by sessionID.
let ocEventReq = null
let ocEventConnected = false
let ocEventWaiters = []
const ocSubscribers = new Map() // sid -> Set<fn>

function flushEventWaiters() {
  const waiters = ocEventWaiters
  ocEventWaiters = []
  for (const resolve of waiters) resolve()
}

function connectOcEvents() {
  if (ocEventReq) return
  const req = http.get(OC_URL + "/api/event", {
    headers: { Authorization: OC_AUTH, Accept: "text/event-stream" },
  }, res => {
    if (res.statusCode !== 200) {
      res.resume()
      ocEventReq = null
      setTimeout(connectOcEvents, 3000)
      return
    }
    ocEventConnected = true
    flushEventWaiters()
    let buf = ""
    res.setEncoding("utf8")
    res.on("data", chunk => {
      // opencode emits LF, but SSE spec allows CRLF — normalize the
      // CONCATENATED buffer so a chunk ending in \r and the next starting
      // with \n is also caught; per-chunk replace misses that split and
      // drops the event.
      buf = (buf + chunk).replace(/\r\n/g, "\n")
      let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue
          let ev
          try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
          const sid = ev?.data?.sessionID
          const subs = sid && ocSubscribers.get(sid)
          if (!subs) continue
          for (const fn of Array.from(subs)) {
            try { fn(ev) } catch (e) { console.error("[events] handler error: " + e) }
          }
        }
      }
    })
    const drop = () => {
      if (ocEventReq !== req) return
      ocEventReq = null
      ocEventConnected = false
      setTimeout(connectOcEvents, 1000)
    }
    res.on("end", drop)
    res.on("error", drop)
  })
  req.on("error", () => {
    ocEventReq = null
    ocEventConnected = false
    setTimeout(connectOcEvents, 1000)
  })
  req.end()
  ocEventReq = req
}

function ensureOcEvents() {
  if (ocEventConnected) return Promise.resolve()
  const waiter = new Promise(resolve => ocEventWaiters.push(resolve))
  if (!ocEventReq) connectOcEvents()
  // Never block the request on a down event stream — the caller's own
  // deadline/prompt error handles the failure case.
  return Promise.race([waiter, new Promise(resolve => setTimeout(resolve, 5000))])
}

function subscribeOc(sid, fn) {
  if (!ocSubscribers.has(sid)) ocSubscribers.set(sid, new Set())
  ocSubscribers.get(sid).add(fn)
  return () => {
    const set = ocSubscribers.get(sid)
    if (!set) return
    set.delete(fn)
    if (!set.size) ocSubscribers.delete(sid)
  }
}

// ---- Anthropic live stream sink ----
// Lazily opens the SSE response on the first real content so that a model
// failing BEFORE any byte (429, quota) can still fall back to the next one.
function createAnthropicSink(res, model, inputTokens = 0) {
  const id = "msg_bridge_" + Date.now()
  const started = Date.now()
  let open = false
  let block = null // "thinking" | "text"
  let index = -1
  let finished = false
  let clientGone = false
  const abortHooks = []
  // input_tokens = honest estimate of the client's request (see
  // estimateRequestTokens); cache stays 0 — opencode's values are
  // session-cumulative and must never reach the TUI's auto-compact math.
  const totals = {
    input_tokens: Math.max(1, inputTokens | 0),
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }

  res.on("close", () => {
    if (finished || clientGone) return
    clientGone = true
    for (const fn of abortHooks.splice(0)) { try { fn() } catch { /* ignore */ } }
  })

  const write = (event, data) => {
    try { res.write(sseEvent(event, data)) } catch { /* client gone */ }
  }
  const ensure = () => {
    if (open) return
    open = true
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
    write("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }
  const closeBlock = () => {
    if (!block) return
    write("content_block_stop", { type: "content_block_stop", index })
    block = null
  }
  const openBlock = type => {
    closeBlock()
    index++
    block = type
    write("content_block_start", {
      type: "content_block_start", index,
      content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    })
  }
  return {
    get started() { return open },
    get finished() { return finished },
    get clientGone() { return clientGone },
    onClose(fn) {
      if (clientGone) { fn(); return () => {} }
      abortHooks.push(fn)
      return () => {
        const i = abortHooks.indexOf(fn)
        if (i >= 0) abortHooks.splice(i, 1)
      }
    },
    thinking(delta) {
      if (!delta || finished) return
      ensure()
      if (block !== "thinking") openBlock("thinking")
      write("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: delta } })
    },
    text(delta) {
      if (!delta || finished) return
      ensure()
      if (block !== "text") openBlock("text")
      write("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: delta } })
    },
    usage(tokens) {
      if (!open || finished || !tokens) return
      const output = Math.max(totals.output_tokens, tokens.output | 0)
      // input/cache are NEVER taken from opencode (session-cumulative →
      // millions of cache reads after a few tool rounds); only output moves
      // mid-stream. Mid-stream message_delta carries ONLY output_tokens: the
      // TUI's cost tracker (addToTotalSessionCost) ADDS the usage of every
      // message_delta it receives, and the real Anthropic API sends exactly
      // one full usage. Re-sending the full cumulative usage here would
      // inflate session token totals ~3x. Output is small (tens-hundreds of
      // tokens) and is the number the live counter shows; input arrives once,
      // in the final message_delta (already set from the request estimate).
      if (output === totals.output_tokens) return
      totals.output_tokens = output
      write("message_delta", { type: "message_delta", delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: output } })
    },
    finish(stopReason = "end_turn") {
      if (finished) return
      ensure()
      closeBlock()
      write("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { ...totals },
      })
      write("message_stop", { type: "message_stop" })
      finished = true
      res.end()
      console.log("POST /v1/messages (stream) 200 live " + (Date.now() - started) + "ms, " + (index + 1) + " block(s), " + totals.input_tokens + "in/" + totals.output_tokens + "out")
    },
  }
}

// On text/reasoning.ended opencode gives the COMPLETE item text — resend
// whatever deltas we missed (event reconnects) so the final content is exact.
function syncEnded(d, emit, delivered) {
  const full = typeof d.text === "string" ? d.text : ""
  if (!full) return
  const key = (d.assistantMessageID || "") + ":" + (d.ordinal ?? 0)
  const already = delivered.get(key) || 0
  if (full.length > already) emit(full.slice(already))
  delivered.set(key, full.length)
}

function eventError(d, fallback) {
  const err = d?.error ?? d
  const msg = typeof err?.message === "string" ? err.message : null
  if (msg) return msg
  const outcome = typeof d?.outcome === "string" ? d.outcome : null
  if (outcome && outcome !== "failed") return fallback + " (outcome: " + outcome + ")"
  return fallback
}

// ---- live streaming turn (event-driven) ----
async function attemptOpencodeStream(model, prompt, sink, deadlineMs) {
  const sid = await newSession()
  let offSub = () => {}
  let offAbort = () => {}
  try {
    await setModelOnSession(sid, model)
    await ensureOcEvents()
    const delivered = new Map() // "msgID:ordinal" -> chars already emitted
    const bump = (d, delta) => {
      if (typeof delta !== "string" || !delta) return
      const key = (d.assistantMessageID || "") + ":" + (d.ordinal ?? 0)
      delivered.set(key, (delivered.get(key) || 0) + delta.length)
    }
    const result = await new Promise(resolve => {
      let settled = false
      let timer = null
      let graceTimer = null
      let succeededSeen = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(graceTimer)
        resolve(value)
      }
      offAbort = sink.onClose(() => finish({ error: "client disconnected" }))
      timer = setTimeout(() => finish({ error: "timed out after " + deadlineMs + "ms waiting for a reply" }), deadlineMs)
      offSub = subscribeOc(sid, ev => {
        const d = ev.data ?? {}
        switch (ev.type) {
          case "session.reasoning.delta":
            if (typeof d.delta === "string" && d.delta) { sink.thinking(d.delta); bump(d, d.delta) }
            break
          case "session.reasoning.ended":
            syncEnded(d, t => sink.thinking(t), delivered)
            break
          case "session.text.delta":
            if (typeof d.delta === "string" && d.delta) { sink.text(d.delta); bump(d, d.delta) }
            break
          case "session.text.ended":
            syncEnded(d, t => sink.text(t), delivered)
            break
          case "session.usage.updated":
            sink.usage(d.tokens)
            // The authoritative final usage lands just AFTER
            // execution.succeeded. Once we've seen success, the next
            // usage.updated is the last word — close on it (short debounce
            // in case another event is still in flight).
            if (succeededSeen) {
              clearTimeout(graceTimer)
              graceTimer = setTimeout(() => finish({ ok: true }), 150)
            }
            break
          case "session.execution.succeeded":
            succeededSeen = true
            // idle may never arrive on the event stream — don't wait for it
            // forever; the next usage.updated closes earlier anyway.
            if (!graceTimer) graceTimer = setTimeout(() => finish({ ok: true }), 2000)
            break
          case "session.execution.failed":
            finish({ error: eventError(d, "opencode turn failed") })
            break
          case "session.execution.interrupted":
            finish({ error: "turn interrupted" })
            break
          case "session.error":
            finish({ error: eventError(d, "opencode session error") })
            break
          case "session.idle":
            if (d.outcome === "failed") finish({ error: eventError(d, "opencode turn failed (outcome: failed)") })
            else if (d.outcome === "succeeded" || d.outcome === "completed") finish({ ok: true })
            break
        }
      })
      // Subscribe BEFORE the prompt: opencode only replays events to clients
      // that were connected when they happened.
      oc("POST", "/api/session/" + sid + "/prompt", { text: prompt }, 15000)
        .catch(err => finish({ error: String(err.message || err) }))
    })
    return result
  } finally {
    offAbort()
    offSub()
    try { await oc("DELETE", "/api/session/" + sid, undefined, 5000) } catch { /* already gone */ }
  }
}

// Cascade fallback for the LIVE path: only hops to the next model while the
// sink has emitted nothing (no bytes = no visible glitch). Once content is on
// the wire we stop and close gracefully with whatever we have.
async function streamOpencodeTurnWithFallback(model, prompt, sink, directive = DIRECTIVE) {
  const chain = [model, ...FALLBACKS.filter(m => m !== model)]
    .slice(0, Number(process.env.OC_BRIDGE_MAX_MODELS ?? 3))
  const deadlineMs = Number(process.env.OC_BRIDGE_DEADLINE ?? 150000)
  let last = "no model in fallback chain"
  for (const m of chain) {
    if (sink.clientGone) return "client disconnected"
    const bare = toOpencodeModel(m)
    const t0 = Date.now()
    let result
    try {
      result = await attemptOpencodeStream(bare, directive + prompt, sink, deadlineMs)
    } catch (err) {
      result = { error: String(err.message || err) }
    }
    const ms = Date.now() - t0
    if (result.ok && sink.started) {
      if (m !== model) console.log("[fallback] " + model + " failed, served by " + m + " in " + ms + "ms")
      return null
    }
    const error = result.ok ? "opencode turn completed without a reply" : result.error
    last = error
    console.log("[fallback] " + bare + " failed after " + ms + "ms: " + String(error).slice(0, 80))
    if (sink.started) return null // bytes already on the wire — no restart possible
    if (sink.clientGone) return "client disconnected"
    if (String(error).includes("timed out")) break // heavy prompt: next model would be just as slow
  }
  return last
}

// ---- honest usage ----
// opencode's session.usage.updated reports SESSION-cumulative tokens: across
// an agentic turn (N internal rounds) input sums to ~200k and cache reads to
// MILLIONS. OpenClaude's tokenCountWithEstimation adds input+cache_creation+
// cache_read+output of the last assistant message to decide auto-compact, so
// forwarding those numbers made every agentic turn look like a >1M-token
// context overflow → compact after EVERY turn, forever. Instead report what
// the real Anthropic API would report for the request we received: system +
// tools + messages (~4 chars/token), caches at 0 (we don't cache).
function estimateRequestTokens(body) {
  let chars = 0
  const add = value => { if (typeof value === "string") chars += value.length }
  add(typeof body.system === "string" ? body.system : "")
  if (Array.isArray(body.system)) {
    for (const s of body.system) add(typeof s === "string" ? s : s?.text)
  }
  if (Array.isArray(body.tools)) chars += JSON.stringify(body.tools).length
  for (const msg of body.messages ?? []) {
    const c = msg?.content
    if (typeof c === "string") { chars += c.length; continue }
    if (!Array.isArray(c)) continue
    for (const part of c) {
      if (typeof part === "string") chars += part.length
      else { add(part?.text); add(part?.thinking) }
    }
  }
  return Math.max(1, Math.ceil(chars / 4))
}

// Auto-compact sends its summary instructions as the LAST user message
// (getCompactPrompt → BASE_COMPACT_PROMPT, both compact call sites). Such a
// request is a task for a summarization engine: no agent directive, and a
// much larger truncation budget so the instructions and enough of the
// conversation survive.
function isCompactionRequest(body) {
  const messages = body.messages ?? []
  const last = messages[messages.length - 1]
  let content = last?.content
  if (Array.isArray(content)) {
    content = content.map(p => (typeof p === "string" ? p : p?.text ?? "")).join("\n")
  }
  return typeof content === "string" &&
    content.includes("create a detailed summary of the conversation")
}

// ---- Anthropic translation ----
function anthropicToPrompt(body) {
  const parts = []
  // opencode's agent has its own system prompt + tools; a huge forwarded
  // system prompt only confuses free models ("Je vais explorer…") and
  // inflates latency. Keep it only when the client sent a short one.
  const MAX_SYSTEM = Number(process.env.OC_BRIDGE_MAXSYSTEM ?? 1500)
  let sys = ""
  if (typeof body.system === "string") sys = body.system.trim()
  else if (Array.isArray(body.system)) {
    sys = body.system.map(s => (typeof s === "string" ? s : s?.text ?? "")).filter(Boolean).join("\n").trim()
  }
  if (sys && sys.length <= MAX_SYSTEM) parts.push(sys)
  else if (sys) console.log("[bridge] dropping oversized system prompt (" + sys.length + " chars)")
  for (const msg of body.messages ?? []) {
    const role = msg.role === "assistant" ? "Assistant" : "User"
    let content = msg.content
    if (Array.isArray(content)) {
      content = content.map(c => (typeof c === "string" ? c : c?.type === "text" ? c.text : "")).filter(Boolean).join("\n")
    }
    if (content && String(content).trim()) parts.push(role + ": " + content)
  }
  return parts.join("\n\n")
}

function anthropicResponse({ model, text, stopReason = "end_turn", inputTokens = 0 }) {
  return {
    id: "msg_bridge_" + Date.now(),
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    // input = estimate of what the client sent (see estimateRequestTokens);
    // output ≈ chars/4 of the reply. Same shape as the stream paths so the
    // TUI's context estimate is consistent no matter which path answered.
    usage: { input_tokens: Math.max(1, inputTokens | 0), output_tokens: Math.ceil((text ?? "").length / 4) },
  }
}

function anthropicError(message) {
  return { type: "error", error: { type: "api_error", message } }
}

// ---- Model listing ----
const PROVIDER_ORDER = ["opencode", "cline", "nim", "openai"]

async function listModels() {
  const out = []
  try {
    const data = await oc("GET", "/api/model", undefined, 15000)
    for (const m of data.data ?? []) {
      if (!m?.id || m.providerID !== "opencode") continue
      out.push({
        provider: "opencode",
        object: "model",
        id: m.id,
        display_name: m.name ?? m.id,
        type: "model",
        created: 0,
        owned_by: "opencode",
      })
    }
  } catch (error) {
    console.error("[opencode] catalog failed: " + (error.message || error).slice(0, 120))
  }
  for (const model of readClineCandidates()) {
    const status = clineStatus.get(model)
    out.push({
      provider: "cline",
      object: "model",
      id: model,
      display_name: model.split("/").pop(),
      type: "model",
      created: 0,
      owned_by: "cline",
      status: status ? { state: status.state, latencyMs: status.latencyMs, checkedAt: status.checkedAt } : { state: "unchecked" },
    })
  }
  try {
    const data = await fcc("GET", "/v1/models", undefined, 15000)
    const seenReal = new Set()
    for (const m of data.data ?? []) {
      const raw = m?.id
      // FCC ids are "<surface>/<provider>/<model...>". Advertise everything on
      // the "anthropic" surface that carries a provider segment — that covers
      // nim, the OpenAI ChatGPT free tier, and any custom provider configured
      // in the FCC admin (custom_<hash>/...). Bare claude-* aliases and the
      // duplicate "claude-3-freecc-no-thinking" surface are skipped by
      // construction, so no cross-surface dedup is needed.
      if (!raw || typeof raw !== "string" || !raw.startsWith("anthropic/")) continue
      const real = raw.slice("anthropic/".length)
      if (!real.includes("/") || seenReal.has(real)) continue
      seenReal.add(real)
      // Keep the historical tags for the two known backends; custom providers
      // keep their FCC id segment so they stay recognizable in the picker.
      const provider = real.startsWith("nvidia_nim/") ? "nim"
        : real.startsWith("openai/") ? "openai"
        : real.slice(0, real.indexOf("/"))
      out.push({
        provider,
        object: "model",
        id: "anthropic/" + real,
        display_name: m.display_name ?? real,
        type: "model",
        created: 0,
        owned_by: provider,
      })
    }
  } catch (error) {
    console.error("[fcc] catalog failed: " + (error.message || error).slice(0, 120))
  }
  out.sort((a, b) => {
    // Unknown providers (custom FCC backends, ...) sort after the known ones.
    const rank = p => {
      const i = PROVIDER_ORDER.indexOf(p)
      return i === -1 ? PROVIDER_ORDER.length : i
    }
    const pa = rank(a.provider)
    const pb = rank(b.provider)
    if (pa !== pb) return pa - pb
    return a.id.localeCompare(b.id)
  })
  return out
}

// ---- HTTP surface ----


/** Warm-up: load the default model before serving traffic.
 * 
 * Measured: the first turn after the bridge has been idle accepts its prompt in
 * ~200 ms but then never produces a reply — the model has to be loaded into
 * memory first, and that load outlasts the poll deadline. Every later turn is
 * fast. Warming once at startup means the first real request is fast too. */
async function warmUp() {
  const model = toOpencodeModel(process.env.OC_BRIDGE_MODEL ?? "space-bunny-free")
  console.log("[warmup] loading " + model + "…")
  const started = Date.now()
  try {
    const reply = await runOpencodeTurn(model, "Reply with exactly: WARMUP")
    if (reply.error) {
      console.log("[warmup] failed (" + ((Date.now() - started) / 1000).toFixed(1) + "s): " + reply.error.slice(0, 80))
      console.log("[warmup] the first real request may be slow while the model loads")
    } else {
      console.log("[warmup] ready in " + (((Date.now() - started) / 1000).toFixed(1)) + "s")
    }
  } catch (error) {
    console.log("[warmup] threw: " + (error.message || error).slice(0, 120))
  }
}

// ---- HTTP server ----

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  const url = new URL(req.url, "http://127.0.0.1:" + PORT)
  const done = (status, payload) => {
    console.log(req.method + " " + url.pathname + " " + status + " " + (Date.now() - started) + "ms")
    return send(res, status, payload)
  }
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return done(400, anthropicError("invalid JSON body"))
    }
    const model = body.model ?? FCC_MODEL
    // Honest usage for THIS request (what the TUI's auto-compact math needs)
    // and a summarization directive for compact prompts — both computed
    // BEFORE truncation, while the raw body is intact.
    const inputTokens = estimateRequestTokens(body)
    const compact = isCompactionRequest(body)
    const directive = compact ? COMPACT_DIRECTIVE : DIRECTIVE
    // Tool-bearing turns on FCC models are proxied through as native
    // Anthropic Messages (system + messages + tools intact): the TUI needs
    // real tool_use blocks back and sends tool_result on the next call —
    // a flattened text prompt can't carry that loop. Compaction stays on
    // the flattened path below (summarization must never call tools), and
    // on proxy failure we fall through to the flattened cascade.
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    if (!compact && hasTools && isNimModel(model)) {
      try {
        return await proxyFccTurn(body, model, res, inputTokens)
      } catch (err) {
        console.log("[fcc] transparent proxy failed (" + String(err.message || err).slice(0, 160) + ") — flattened fallback")
      }
    }
    let prompt = anthropicToPrompt(body)
    if (!prompt.trim()) return done(400, anthropicError("no prompt content in request"))
    // Free-tier providers choke on multi-thousand-token generation budgets;
    // clamp to something realistic for a coding agent reply (override via env).
    let cap = Number(process.env.OC_BRIDGE_MAXTOKENS ?? 4096)
    if (!Number.isFinite(cap) || cap <= 0) cap = 4096
    if (typeof body.max_tokens === "number" && body.max_tokens > cap) {
      body.max_tokens = cap
    }
    // OpenClaude re-sends the full system+tool catalog every turn; without
    // pruning the prompt blows past 30k chars and the turn never completes.
    // Compaction gets a much bigger budget (60k chars): its instructions are
    // the LAST message and must survive intact, plus enough conversation for
    // a useful summary. Truncating it to 8k chars (old behavior) destroyed
    // the instructions → the summary never came back → compact loop.
    const limit = compact ? 60000 : 8000
    if (prompt.length > limit) {
      const headLen = compact ? 15000 : 3000
      const head = prompt.slice(0, headLen)
      const tail = prompt.slice(-(limit - headLen))
      prompt = head + "\n...[bridge: middle of prompt truncated]...\n" + tail
      console.log("[bridge] truncated long prompt (kept head+tail" + (compact ? ", compaction budget " + limit : "") + ")")
    }
    if (compact) console.log("[bridge] compaction request detected — summarization directive, no tools")
    try {
      // Live streaming path (opencode): forward reasoning/text/usage deltas
      // from /api/event as they happen, so the TUI shows thinking and token
      // consumption in real time. cline/nim don't expose events — they keep
      // the buffered path below.
      if (body.stream && !isClineModel(model) && !isNimModel(model)) {
        const sink = createAnthropicSink(res, model, inputTokens)
        const error = await streamOpencodeTurnWithFallback(model, prompt, sink, directive)
        if (error && !sink.started) return done(502, anthropicError(error))
        // Content already on the wire: close gracefully with what we have.
        if (!sink.clientGone) sink.finish("end_turn")
        return
      }
      // Cascade: free tiers 429/timeout unpredictably depending on the hour.
      // On failure, silently fall back to the next model in the chain so the
      // user still gets an answer instead of "API server error".
      const reply = await runTurnWithFallback(model, prompt, body.max_tokens, directive)
      if (reply.error) return done(502, anthropicError(reply.error))
      if (body.stream) return sendStream(res, model, reply.text, inputTokens)
      return done(200, anthropicResponse({ model, text: reply.text, inputTokens }))
    } catch (err) {
      return done(502, anthropicError(String(err.message || err)))
    }
  }
  if (req.method === "GET" && url.pathname === "/v1/models") return done(200, { object: "list", data: await listModels() })
  done(404, anthropicError("unknown path " + url.pathname))
})

// Start listening — without this the process exits immediately
server.listen(PORT, "127.0.0.1", () => {
  console.log(`free-model bridge on http://127.0.0.1:${PORT}/v1`)
})

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ""
    req.on("data", c => { raw += c; if (raw.length > 8_000_000) reject(new Error("body too large")) })
    req.on("end", () => resolve(raw))
    req.on("error", reject)
  })
}

function send(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length })
  res.end(data)
}

// ---- SSE streaming ----
// The TUI always sends stream: true. A plain JSON body would fail to parse
// as an SSE stream, so emit the Anthropic event sequence for the final text.
function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sendStream(res, model, text, inputTokens = 0) {
  const id = "msg_bridge_" + Date.now()
  const body = text ?? ""
  const events = [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" },
    }),
  ]
  if (body) {
    events.push(sseEvent("content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: body },
    }))
  }
  events.push(
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      // Same honest shape as the live sink: input once here (request
      // estimate), output ≈ chars/4 — see review #3.
      usage: { input_tokens: Math.max(1, inputTokens | 0), output_tokens: Math.floor(body.length / 4) },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  )
  const data = Buffer.from(events.join(""))
  console.log("POST /v1/messages (stream) 200 " + data.length + "B")
  res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": data.length })
  res.end(data)
}

// ---- Boot ----

if (!FCC_TOKEN) console.warn("[bridge] FCC_TOKEN not configured — FCC catalog disabled (nim + openai chatgpt); set FCC_TOKEN (any value when FCC auth is off)")
refreshCline().catch(error => console.error("[cline] probe failed: " + (error.message || error).slice(0, 120)))
setInterval(() => refreshCline().catch(() => {}), CLINE_REFRESH_MS).unref()
ensureOcEvents().then(() => console.log("[events] /api/event stream connected")).catch(() => {})
warmUp().catch(() => {})
