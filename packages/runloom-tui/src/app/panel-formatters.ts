export function formatPanelHeader(name: string, total: number, start: number, count: number, scrollOffset: number): string {
  if (total <= count && scrollOffset === 0) {
    return `${name}:`;
  }
  const first = count > 0 ? start + 1 : 0;
  const last = start + count;
  const offset = scrollOffset > 0 ? ` offset=${scrollOffset}` : "";
  return `${name}: showing ${first}-${last} of ${total}${offset}`;
}
