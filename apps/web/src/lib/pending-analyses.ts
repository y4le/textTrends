interface AnalysisStatus {
  readonly status: string;
}

/** Count live analysis intents without double-counting the shared baseline
 * object used by `inventory` and `corpusInventory` outside a linked range. */
export function pendingAnalysisCount(input: {
  readonly inventory: AnalysisStatus | null | undefined;
  readonly corpusInventory: AnalysisStatus | null | undefined;
  readonly other: readonly (AnalysisStatus | null | undefined)[];
  readonly maps: readonly ReadonlyMap<unknown, AnalysisStatus>[];
}): number {
  const corpusInventory = input.corpusInventory === input.inventory
    ? undefined
    : input.corpusInventory;
  return [input.inventory, corpusInventory, ...input.other]
    .filter((item) => item?.status === 'pending').length
    + input.maps.reduce(
      (count, map) => count + [...map.values()].filter((item) => item.status === 'pending').length,
      0,
    );
}
