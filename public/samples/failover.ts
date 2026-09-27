/** Pick the next eligible model after `failed` leaves the chain. */
export function nextModel<T extends { id: string }>(
  chain: readonly T[],
  failedIds: ReadonlySet<string>,
): T | undefined {
  return chain.find((m) => !failedIds.has(m.id));
}

const chain = [{ id: "gpt-4o" }, { id: "claude-sonnet-4-5" }];
console.log(nextModel(chain, new Set(["gpt-4o"]))?.id);
// => "claude-sonnet-4-5"
