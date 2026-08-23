const min = () => Number(process.env.MIN_ACTION_DELAY_MS ?? 800);
const max = () => Number(process.env.MAX_ACTION_DELAY_MS ?? 2200);

/** Sleeps a randomized, human-scale interval so we don't hammer job boards. */
export async function humanDelay() {
  const lo = min();
  const hi = Math.max(max(), lo);
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `items` through `worker` one at a time, with a human delay between each. */
export async function throttledMap(items, worker) {
  const results = [];
  for (const item of items) {
    results.push(await worker(item));
    await humanDelay();
  }
  return results;
}
