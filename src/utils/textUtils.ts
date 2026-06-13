// Text helpers for the terminal-style views (web + glasses): trimming output to a
// screenful and parsing the CLI's trailing prompt.

// CJK and other full-width Unicode ranges that occupy 2 display columns.
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    cp === 0x2014 ||                    // em dash — (破折号)
    (cp >= 0x2018 && cp <= 0x201d) ||  // curly single/double quotes ' ' " " (弯引号)
    cp === 0x2026 ||                    // horizontal ellipsis … (省略号)
    (cp >= 0x2e80 && cp <= 0x303f) ||   // CJK Radicals / Kangxi / Punctuation
    (cp >= 0x3040 && cp <= 0x33ff) ||   // Hiragana, Katakana, Bopomofo, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs (most common)
    (cp >= 0xa960 && cp <= 0xa97f) ||   // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7ff) ||   // Hangul Syllables + Jamo Extended-B
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe6f) ||   // Vertical/CJK Compat Forms, Small Forms
    (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth Latin/punctuation
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth signs
    (cp >= 0x20000 && cp <= 0x3134f)    // CJK Extensions B–G (supplementary)
  );
}

// Display column width of a string: CJK and other wide characters count as 2.
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

// String (UTF-16) index at which the display width of s.slice(0, idx) first reaches
// maxWidth. Use this to split a string at a display-column boundary.
export function charIndexForWidth(s: string, maxWidth: number): number {
  let w = 0;
  let i = 0;
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > maxWidth) break;
    w += cw;
    i += ch.length; // ch.length handles surrogate pairs correctly
  }
  return i;
}

// Suffix of `s` whose display width is at most `maxWidth` columns.
function sliceTailByWidth(s: string, maxWidth: number): string {
  const chars = [...s]; // split into code points
  let w = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = isWide(chars[i].codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > maxWidth) break;
    w += cw;
    start = i;
  }
  return chars.slice(start).join("");
}

// Keep the last `maxRows` wrapped rows of `text`, dropping whole lines from the top.
// If the bottom-most line alone overflows, keep just its trailing screenful of chars.
// `charsPerLine` is the display-column capacity of one wrapped row at the target font.
// CJK characters count as 2 columns so mixed/Chinese content wraps correctly.
export function tailRows(text: string, maxRows: number, charsPerLine: number): string {
  if (maxRows < 1) maxRows = 1;
  const wrapped = (line: string) => Math.max(1, Math.ceil(displayWidth(line) / charsPerLine));
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const rows = wrapped(lines[i]);
    if (used + rows > maxRows) {
      if (kept.length === 0) kept.unshift(sliceTailByWidth(lines[i], maxRows * charsPerLine));
      break;
    }
    used += rows;
    kept.unshift(lines[i]);
  }
  return kept.join("\n");
}

// Extract the trailing CLI prompt (e.g. "gpt-5.5> ") from the output, if any.
export function trailingPrompt(text: string): string {
  const m = text.match(/(?:^|\n)([^\n]*?>[ \t]*)$/);
  return m ? m[1] : "";
}

// Drop a trailing CLI prompt line (e.g. "gpt-5.5> ") from the output, keeping any
// leading newline. Used before re-adding the prompt so it's never duplicated.
export function stripTrailingPrompt(text: string): string {
  return text.replace(/(^|\n)[^\n]*?>[ \t]*$/, "$1");
}
