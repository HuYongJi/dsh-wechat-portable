export const MAX_WECHAT_TEXT_LENGTH = 4000;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Keep every character, including code indentation and paragraph separators. */
export function takeWechatBatch(text: string, maxLength: number): [string, string] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 2) throw new RangeError('maxLength must be an integer >= 2');
  if (text.length <= maxLength) return [text, ''];
  const minimum = maxLength * 0.3;
  let cut = text.lastIndexOf('\n\n', maxLength - 2);
  if (cut >= minimum) cut += 2;
  else {
    cut = text.lastIndexOf('\n', maxLength - 1);
    if (cut >= minimum) cut++;
    else {
      cut = -1;
      for (let i = maxLength; i >= minimum; i--) {
        if (/[。！？.!?]\s?$/.test(text.slice(Math.max(0, i - 2), i))) { cut = i; break; }
      }
      if (cut < minimum) {
        cut = text.lastIndexOf(' ', maxLength - 1);
        cut = cut >= minimum ? cut + 1 : maxLength;
      }
    }
  }
  // Prefer a whole emoji/combining sequence, not merely a whole UTF-16 pair.
  let boundary = 0;
  for (const segment of graphemes.segment(text)) {
    const end = segment.index + segment.segment.length;
    if (end > cut) {
      if (!boundary && end <= maxLength) boundary = end;
      break;
    }
    boundary = end;
  }
  // A pathological grapheme can itself exceed the transport limit. In that case
  // enforce the limit but still never split a Unicode surrogate pair.
  if (!boundary) {
    boundary = cut;
    if (/[\uD800-\uDBFF]/.test(text[boundary - 1]) && /[\uDC00-\uDFFF]/.test(text[boundary])) boundary--;
  }
  return [text.slice(0, boundary), text.slice(boundary)];
}

/** Split an already formatted view. Retries must NOT run Markdown cleanup again. */
export function splitWechatText(text: string, maxLength = MAX_WECHAT_TEXT_LENGTH): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 2) throw new RangeError('maxLength must be an integer >= 2');
  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    const [chunk, rest] = takeWechatBatch(remaining, maxLength);
    chunks.push(chunk);
    remaining = rest;
  }
  return chunks;
}
