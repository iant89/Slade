/**
 * Registry of in-flight generations, keyed by conversation.
 *
 * Shared by the plain failover chain (`send.ts`) and the orchestrator agent
 * (`agent.ts`) so `stopGeneration` / the composer's Stop button / the
 * "already streaming here" guard behave identically for both run kinds.
 */

export interface ActiveRun {
  controller: AbortController
  userAborted: boolean
}

const active = new Map<string, ActiveRun>()

export function registerRun(conversationId: string, controller: AbortController): ActiveRun {
  const run: ActiveRun = { controller, userAborted: false }
  active.set(conversationId, run)
  return run
}

export function getRun(conversationId: string): ActiveRun | undefined {
  return active.get(conversationId)
}

export function finishRun(conversationId: string): void {
  active.delete(conversationId)
}

export function isGenerating(conversationId: string): boolean {
  return active.has(conversationId)
}

export function stopGeneration(conversationId: string): void {
  const run = active.get(conversationId)
  if (run) {
    run.userAborted = true
    run.controller.abort()
  }
}
