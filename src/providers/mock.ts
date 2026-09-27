import type { Artifact, ModelDef } from '../types'
import type { AttemptConfig, ProviderAdapter, KeyTestResult } from './base'
import { ProviderError } from './base'
import { uid } from '../lib/id'
import { kindLabel } from '../lib/mime'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* Mock reply generation                                               */
/* ------------------------------------------------------------------ */

function persona(model: ModelDef): 'rich' | 'terse' {
  return model.apiModel.includes('pro') ? 'rich' : 'terse'
}

const SALES_CSV = `month,region,units,revenue_usd,refund_rate
July,West,1240,48960.00,0.021
July,East,1610,63595.00,0.017
August,West,1385,54707.50,0.019
August,East,1750,69125.00,0.014
September,West,1502,59329.00,0.012
September,East,1904,75208.00,0.011`

function pickCodeSample(prompt: string): { lang: string; name: string; code: string } {
  if (/python|pandas|plot|numpy/i.test(prompt)) {
    return {
      lang: 'python',
      name: 'quarterly_report.py',
      code: `import pandas as pd

def summarize(path: str = "sales_q3.csv") -> pd.DataFrame:
    """Aggregate Q3 sales by month with refund-adjusted revenue."""
    df = pd.read_csv(path)
    df["net_revenue"] = df["revenue_usd"] * (1 - df["refund_rate"])
    report = (
        df.groupby("month", as_index=False)
          .agg(units=("units", "sum"), net_revenue=("net_revenue", "sum"))
          .sort_values("month")
    )
    report["mom_growth"] = report["net_revenue"].pct_change().round(4)
    return report

if __name__ == "__main__":
    print(summarize().to_string(index=False))`,
    }
  }
  if (/react|component|hook|tsx|frontend|ui/i.test(prompt)) {
    return {
      lang: 'tsx',
      name: 'StatusGauge.tsx',
      code: `import { useDeferredValue, useMemo } from "react";

interface GaugeProps { value: number; max: number; label: string; }

export function StatusGauge({ value, max, label }: GaugeProps) {
  const pct = useDeferredValue(Math.min(1, value / max));
  const tone = useMemo(
    () => (pct > 0.85 ? "var(--danger)" : pct > 0.6 ? "var(--warn)" : "var(--ok)"),
    [pct]
  );
  return (
    <div role="meter" aria-valuenow={value} aria-valuemax={max} aria-label={label}
         className="gauge" style={{ "--fill": tone } as React.CSSProperties}>
      <div className="gauge-fill" style={{ width: \`\${pct * 100}%\` }} />
      <span className="gauge-label">{label}</span>
    </div>
  );
}`,
    }
  }
  return {
    lang: 'typescript',
    name: 'failover.ts',
    code: `/** Pick the next eligible model after \`failed\` leaves the chain. */
export function nextModel<T extends { id: string }>(
  chain: readonly T[],
  failedIds: ReadonlySet<string>,
): T | undefined {
  return chain.find((m) => !failedIds.has(m.id));
}

const chain = [{ id: "gpt-4o" }, { id: "claude-sonnet-4-5" }];
console.log(nextModel(chain, new Set(["gpt-4o"]))?.id);
// => "claude-sonnet-4-5"`,
  }
}

function mockReply(prompt: string, artifacts: Artifact[], model: ModelDef): string {
  const p = prompt.trim()
  const style = persona(model)
  const att = artifacts.length
    ? `\n\nI can see ${artifacts.length === 1 ? `the file you attached — **${artifacts[0]!.name}** (${kindLabel(artifacts[0]!.kind)})` : `${artifacts.length} attached files: ${artifacts.map((a) => `\`${a.name}\``).join(', ')}`} — noted for context.\n`
    : ''

  if (/^(hi|hello|hey|yo|howdy|good (morning|evening|afternoon))\b/i.test(p)) {
    return `Howdy — you're talking to **${model.label}**, routed through Slade.${att}

Here's what I can do from this window:

- **Answer & stream** — replies arrive token by token; hit **Stop** any time.
- **Fail over silently** — if I hit a rate limit or run out of quota, the next model in your priority chain picks up mid-sentence without losing context.
- **Handle artifacts** — drop a CSV, image, code file or audio clip into the composer and I'll read it; ask me to *generate* one and it appears as a card in the thread.

Try: *"generate a CSV of Q3 sales"* or *"show me some TypeScript that picks the next failover model".*`
  }

  const code = pickCodeSample(p)

  if (/csv|spreadsheet|table file|generate.*(file|report)|export/i.test(p)) {
    return `Here's a Q3 sales dataset, generated fresh — it lands below as a spreadsheet artifact you can sort, expand, and download.${att}

### What's inside

| Column | Meaning |
| --- | --- |
| \`month\` | Calendar month of Q3 |
| \`region\` | West / East sales region |
| \`units\` | Units shipped |
| \`revenue_usd\` | Gross revenue |
| \`refund_rate\` | Refunds as a fraction of orders |

\`\`\`csv:sales_q3.csv
${SALES_CSV}
\`\`\`

Want me to summarize it, chart the trend, or send it back through with transformations applied?`
  }

  if (/code|function|script|typescript|python|react|component|example|show me/i.test(p)) {
    return `Here's a worked example — it streams in below as a code artifact with syntax highlighting and a copy button.${att}

### How it works

1. Walk the priority chain in order.
2. Skip anything in the failed set (rate-limited, out of quota, or erroring).
3. Return the first survivor — \`undefined\` means every model is exhausted.

\`\`\`${code.lang}:${code.name}
${code.code}
\`\`\`

> **Design note:** keeping the failure set separate from the chain itself means cooldowns never permute your priority order — they just mask entries until they expire.

Want a test suite for this, or a version that also weights by latency?`
  }

  if (p.endsWith('?')) {
    const topic = p.replace(/\?+$/, '')
    const rich = style === 'rich'
    return `${att}**Short answer:** yes — and ${topic.toLowerCase()} is a good fit for how Slade routes work.

### The longer answer

Slade treats each request as a **chain walk**, not a single call. Your prompt goes to the first eligible model; if that model answers with a rate limit, an exhausted quota, or a hard error, the request is re-issued down the chain with the *entire conversation* intact:

1. **Classify** — the failure is sorted into soft rate limit, hard quota, auth, timeout, network, or overload.
2. **Cool down** — the failed model gets a timed cooldown (with exponential backoff) instead of being disabled forever.
3. **Re-issue** — the next eligible model answers; a subtle divider marks the handoff.

${rich ? '4. **Recover** — the moment the cooled-down model\'s window resets, it rejoins the chain automatically.\n' : ''}So the thread never stalls — worst case, the answer is labeled with the model that actually served it.`
  }

  if (style === 'terse') {
    return `${att}Got it — *"${p.slice(0, 80)}${p.length > 80 ? '…' : ''}"*.

- Routed via **${model.label}** through the Slade chain.
- If I hit a limit, the next model takes over without asking.
- Ask me to **generate a CSV**, **write some code**, or attach a file to see artifact cards.

Anything specific you want to dig into?`
  }

  return `${att}Here's my take on *"${p.slice(0, 120)}${p.length > 120 ? '…' : ''}"*.

### The gist

Everything in Slade is built around one idea: **the conversation is the unit of work, not the request**. Models come and go — cooldowns, quota walls, outages — but the thread, its context, and any attached artifacts stay untouched.

### What that means in practice

| Concern | How it's handled |
| --- | --- |
| Rate limits | Soft cooldown with exponential backoff, then automatic re-entry |
| Quota exhaustion | Marked exhausted; chain continues; recovers on reset |
| Mid-stream failure | Partial output is kept, a divider marks the handoff, the next model continues |
| Attachments | Re-sent as context to whichever model picks up the thread |

> Tip: set **Simulacron Pro** to *simulate a failure* in **Settings → Models**, then send a message and watch the handoff happen live.

Anything you'd like me to go deeper on?`
}

/* ------------------------------------------------------------------ */
/* Mock adapter                                                        */
/* ------------------------------------------------------------------ */

export class MockAdapter implements ProviderAdapter {
  id = 'mock' as const
  label = 'Built-in simulator'

  async run(cfg: AttemptConfig): Promise<void> {
    const { model, turns, onEvent, signal } = cfg

    const simulate = model.simulate ?? 'ok'
    if (simulate !== 'ok' && simulate !== 'timeout') {
      await sleep(350 + Math.random() * 500)
      signal.throwIfAborted()
      throw this.failureFor(simulate)
    }

    const lastUser = [...turns].reverse().find((t) => t.role === 'user')
    const attachments: Artifact[] = [] // attachments are described in text by the orchestrator
    const reply = mockReply(lastUser?.text ?? '', attachments, model)

    if (simulate === 'timeout') {
      // Emit a couple of tokens, then stall past the idle timeout so the
      // orchestrator performs a mid-stream handoff.
      const head = reply.slice(0, 90)
      onEvent({ type: 'delta', text: head })
      await sleep(6_000)
      signal.throwIfAborted()
      throw new ProviderError('timeout', 'Stream stalled — simulated timeout.', true)
    }

    // Stream word-blobs with jittered cadence.
    const tokens = reply.match(/\s*\S+/g) ?? [reply]
    for (const tok of tokens) {
      if (signal.aborted) throw new ProviderError('aborted', 'Cancelled.', false)
      onEvent({ type: 'delta', text: tok })
      await sleep(14 + Math.random() * 46)
    }

    const promptTokens = Math.ceil((lastUser?.text.length ?? 0) / 4)
    const completionTokens = Math.ceil(reply.length / 4)
    onEvent({ type: 'usage', promptTokens, completionTokens })
    onEvent({ type: 'done' })
  }

  async testKey(): Promise<KeyTestResult> {
    return { ok: true, message: 'Built-in simulator is always ready.' }
  }

  private failureFor(simulate: string): ProviderError {
    switch (simulate) {
      case 'soft_rate_limit':
        return new ProviderError('soft_rate_limit', 'Simulated: 429 rate limit reached.', true)
      case 'hard_quota':
        return new ProviderError('hard_quota', 'Simulated: quota exhausted for this billing period.', false)
      case 'network':
        return new ProviderError('network', 'Simulated: network unreachable.', true)
      case 'auth':
        return new ProviderError('auth', 'Simulated: invalid API key.', false)
      case 'bad_request':
        // Shaped like a real Gemini 400, which is what the old UI flattened
        // into "unknown error".
        return new ProviderError(
          'bad_request',
          'Simulated: GenerateContentRequest.generation_config.max_output_tokens must be greater than the thinking budget. (INVALID_ARGUMENT)',
          false,
          400,
        )
      default:
        return new ProviderError('unknown', 'Simulated failure.', true)
    }
  }
}

export const mockAdapter = new MockAdapter()
export { uid }
