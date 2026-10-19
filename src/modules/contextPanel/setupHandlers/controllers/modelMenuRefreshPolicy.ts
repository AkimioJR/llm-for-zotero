/**
 * How long the Codex app-server model catalog loaded for the model menu stays
 * trusted when the user opens the menu again. Each forced reload rebuilds the
 * open menu twice, so re-opening the menu within a minute reuses the list it
 * already has. (Claude Code still forces on every open: its cache identity
 * cannot see in-place ~/.claude/settings.json profile changes, issue #335.)
 */
export const MODEL_MENU_CATALOG_REVALIDATE_MS = 60_000;

/** True when a model-menu open should force a reload of a runtime catalog. */
export function shouldRevalidateCatalogOnMenuOpen(
  lastLoadedAt: number,
  now: number,
): boolean {
  return (
    !(lastLoadedAt > 0) ||
    now - lastLoadedAt >= MODEL_MENU_CATALOG_REVALIDATE_MS
  );
}
