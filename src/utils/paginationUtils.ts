import { displayWidth, charIndexForWidth } from "./textUtils";

// Group the lines of `text` into screenfuls, each holding at most `maxRows` visual rows.
// Pages are returned oldest-first. Long lines that would leave a page half-empty are
// split at word boundaries to fill the page; the remainder continues on the next page.
// This keeps pages full and ensures no word is split across a page turn.
// `charsPerLine` is display columns, so CJK characters (which count as 2) are handled
// correctly — a 48-column line holds ~24 Chinese characters or ~48 ASCII characters.
export function buildPages(text: string, charsPerLine: number, maxRows: number): string[][] {
  const rowCount = (s: string) => Math.max(1, Math.ceil(displayWidth(s) / charsPerLine));
  const pages: string[][] = [];
  let current: string[] = [];
  let used = 0;

  for (const origLine of text.split("\n")) {
    let seg = origLine;
    // A single original line may be split across multiple pages if it is very long.
    while (true) {
      const rows = rowCount(seg);
      if (used + rows <= maxRows) {
        current.push(seg);
        used += rows;
        break;
      }
      // seg doesn't fit whole. Fill the remaining rows on the current page with a
      // word-boundary prefix, then continue with the rest on a new page.
      const rowsLeft = maxRows - used;
      if (rowsLeft > 0) {
        const maxCols = rowsLeft * charsPerLine;
        if (displayWidth(seg) <= maxCols) {
          // Fits in rowsLeft rows (ceil check passes) — add whole and close page.
          current.push(seg);
          used += rows;
          break;
        }
        const cutIndex = charIndexForWidth(seg, maxCols);
        const sp = seg.lastIndexOf(" ", cutIndex);
        const cut = sp > 0 ? sp : cutIndex; // fall back to hard break (e.g. URLs, CJK)
        current.push(seg.slice(0, cut));
        seg = seg.slice(cut + (seg[cut] === " " ? 1 : 0));
      }
      // Commit the current page and start a fresh one.
      if (current.length > 0) { pages.push(current); current = []; used = 0; }
      if (seg.length === 0) break;
    }
  }
  if (current.length > 0) pages.push(current);
  return pages;
}
