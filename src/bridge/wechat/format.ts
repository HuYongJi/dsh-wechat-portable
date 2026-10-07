/**
 * A conservative Markdown-to-text view for WeChat, not a conversation transform.
 * Call with a complete committed assistant message, BEFORE batching/splitting.
 * Never feed the result back into DSH/history or format it a second time: code
 * deliberately retains literal Markdown characters. No network/HTML rendering.
 */

function linkTarget(value: string): string | undefined {
  const input = value.trim();
  const match = input.startsWith('<')
    ? /^<([^<>\n]+)>(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(input)
    : /^(\S+?)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(input);
  const target = match?.[1];
  // A backslash before '(' in a Windows target is a path separator, not an escape.
  if (!target || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(target)) return target;
  return target.replace(/\\([()])/g, '$1');
}

function codeSpan(text: string, start: number): { body: string; end: number } | undefined {
  let openingEnd = start + 1;
  while (text[openingEnd] === '`') openingEnd++;
  const ticks = text.slice(start, openingEnd);
  let close = text.indexOf(ticks, openingEnd);
  while (close !== -1 && (text[close - 1] === '`' || text[close + ticks.length] === '`')) {
    close = text.indexOf(ticks, close + ticks.length);
  }
  return close === -1 ? undefined : { body: text.slice(openingEnd, close), end: close + ticks.length };
}

function protectInlineTokens(text: string, protect: (value: string) => string, nesting: number): string {
  let result = '';
  for (let i = 0; i < text.length;) {
    // Scan in source order: a code span owns its whole body; a link owns its
    // whole destination. Backticks in a filename must not become inline code.
    if (text[i] === '`') {
      const span = codeSpan(text, i);
      if (span) { result += protect(span.body); i = span.end; }
      else { do { result += text[i++]; } while (text[i] === '`'); }
      continue;
    }
    if (text[i] === '<') {
      const autolink = /^<(https?:\/\/[^<>\s]+|mailto:[^<>\s]+)>/.exec(text.slice(i));
      if (autolink) { result += protect(autolink[1]); i += autolink[0].length; continue; }
    }
    const relativePathStart = (i === 0 || /[\s（(，:]/.test(text[i - 1])) && /[\p{L}\p{N}_.~-]/u.test(text[i]);
    if (relativePathStart || 'hm\\/~.'.includes(text[i]) || text[i + 1] === ':') {
      const rest = text.slice(i);
      // Bare Windows paths may contain spaces; if their end is ambiguous, keep
      // the rest of the clause literal rather than deleting a path separator.
      const literal = /^(?:https?:\/\/|mailto:)[^\s<>]+/.exec(rest)
        ?? /^(?:[A-Za-z]:[\\/]|\\\\)[^\n<>，；。！？]+/.exec(rest)
        ?? (!/[\p{L}\p{N}:]/u.test(text[i - 1] ?? '') ? /^(?:~\/|\.{1,2}\/|\/)[^\s<>]+/.exec(rest) : null)
        ?? (relativePathStart ? /^[^\s<>/\\:]+\/[^\s<>]+/.exec(rest) : null);
      if (literal) { result += protect(literal[0]); i += literal[0].length; continue; }
    }
    if (text[i] === '\\' && i + 1 < text.length) { result += text.slice(i, i + 2); i += 2; continue; }
    const image = text[i] === '!' && text[i + 1] === '[';
    const start = image ? i + 1 : i;
    if (text[start] !== '[') { result += text[i++]; continue; }
    let end = start + 1;
    let depth = 1;
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '[') depth++;
      if (text[end] === ']' && --depth === 0) break;
    }
    if (end >= text.length) { result += text.slice(i); break; }
    if (text[end + 1] !== '(') { result += text.slice(i, end + 1); i = end + 1; continue; }
    let close = end + 2;
    depth = 1;
    let angled = false;
    for (; close < text.length; close++) {
      const char = text[close];
      if (char === '\\' && /[()]/.test(text[close + 1] ?? '')) { close++; continue; }
      if (char === '<') angled = true;
      if (char === '>') angled = false;
      if (!angled && char === '(') depth++;
      if (!angled && char === ')' && --depth === 0) break;
    }
    const target = close < text.length ? linkTarget(text.slice(end + 2, close)) : undefined;
    if (!target) { result += text[i++]; continue; }
    const rawLabel = text.slice(start + 1, end);
    const label = nesting < 8 ? formatInline(rawLabel, nesting + 1) : rawLabel;
    const destination = protect(target);
    result += image
      ? label ? `图片：${protect(label)}（${destination}）` : `图片（${destination}）`
      : !label || label === target ? destination : `${protect(label)}（${destination}）`;
    i = close + 1;
  }
  return result;
}

/** Inline code, destinations and literal paths are opaque to decoration cleanup. */
function formatInline(input: string, nesting = 0): string {
  // Pick a sentinel absent from the source, so even private-use characters survive.
  let prefix = '\uE000';
  while (input.includes(prefix)) prefix += '\uE000';
  const values: string[] = [];
  const protect = (value: string): string => `${prefix}${values.push(value) - 1}\uE001`;
  let text = protectInlineTokens(input, protect, nesting);
  text = text.replace(/\\([*_[\]`!|])/g, (_match, value: string) => protect(value));
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Keep intraword underscores and multiplication/glob-like a*b*c literal.
  for (let pass = 0; pass < 3; pass++) {
    text = text
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
      .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '$1')
      .replace(/(?<![\p{L}\p{N}*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu, '$1')
      .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1');
  }
  text = text.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '〔已删除：$1〕');
  // Reverse restoration also resolves a protected destination containing a code
  // placeholder, without ever interpreting restored code as Markdown again.
  for (let i = values.length - 1; i >= 0; i--) text = text.split(`${prefix}${i}\uE001`).join(values[i]);
  return text;
}

/** Split only real table separators; pipes in code or escaped pipes are data. */
function tableCells(line: string): string[] | undefined {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) { cell += char + line[++i]; continue; }
    if (char === '`') {
      const span = codeSpan(line, i);
      if (span) { cell += line.slice(i, span.end); i = span.end - 1; }
      else { do { cell += line[i++]; } while (line[i] === '`'); i--; }
    } else if (char === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  if (!cells.length) return undefined;
  cells.push(cell.trim());
  if (!cells[0] && line.trimStart().startsWith('|')) cells.shift();
  if (!cells.at(-1) && line.trimEnd().endsWith('|')) cells.pop();
  return cells;
}

/** Unsupported cross-line inline spans stay literal, not partially rewritten. */
function multilineCodeEnd(lines: string[], start: number): number | undefined {
  const line = lines[start];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] !== '`') continue;
    const local = codeSpan(line, i);
    if (local) { i = local.end - 1; continue; }
    const rest = lines.slice(start).join('\n');
    const span = codeSpan(rest, i);
    if (span) return start + rest.slice(0, span.end).split('\n').length - 1;
    while (line[i + 1] === '`') i++;
  }
  return undefined;
}

export function formatWechatText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  const blank = () => { if (output.length && output.at(-1) !== '') output.push(''); };
  let fence: { char: string; length: number } | undefined;
  let preserveThrough = 0;
  let indentedCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) { fence = undefined; blank(); }
      else {
        output.push(line); // Preserve indentation, blank lines and ALL code symbols.
        preserveThrough = output.length;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
    if (open) {
      blank();
      const language = open[2].trim();
      output.push(language ? `【代码 · ${language}】` : '【代码】');
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    // Four-space/tab-indented content is conservatively treated as literal,
    // even when it looks like a list. Do not collapse its intervening blank lines.
    if (/^(?: {4}|\t)/.test(line) || (indentedCode && !line.trim())) {
      output.push(line);
      preserveThrough = output.length;
      indentedCode = true;
      continue;
    }
    indentedCode = false;
    const codeEnd = line.includes('`') ? multilineCodeEnd(lines, i) : undefined;
    if (codeEnd !== undefined) {
      output.push(...lines.slice(i, codeEnd + 1));
      preserveThrough = output.length;
      i = codeEnd;
      continue;
    }
    if (!line.trim()) { blank(); continue; }
    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
      blank(); output.push('────────'); blank(); continue;
    }
    const bullet = /^([ \t]*)(?:[-+*])[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/.exec(line);
    const numbered = /^([ \t]*)(\d+)[.)][ \t]+(.*)$/.exec(line);
    if (bullet) {
      const marker = bullet[2] === undefined ? '•' : bullet[2] === ' ' ? '☐' : '☑';
      output.push(`${bullet[1]}${marker} ${formatInline(bullet[3])}`);
      continue;
    }
    if (numbered) { output.push(`${numbered[1]}${numbered[2]}. ${formatInline(numbered[3])}`); continue; }
    const headers = tableCells(line);
    const separator = i + 1 < lines.length ? tableCells(lines[i + 1]) : undefined;
    if (headers?.length && separator?.length === headers.length && separator.every(cell => /^:?-+:?$/.test(cell))) {
      blank();
      i++;
      let rowNumber = 0;
      while (i + 1 < lines.length) {
        const cells = tableCells(lines[i + 1]);
        if (!cells?.length || !lines[i + 1].trim()) break;
        i++;
        blank();
        rowNumber++;
        for (let column = 0; column < Math.max(headers.length, cells.length); column++) {
          const label = formatInline(headers[column] || `第${column + 1}列`);
          const value = formatInline(cells[column] || '（空）');
          output.push(`${column === 0 ? `${rowNumber}. ` : '   '}${label}：${value}`);
        }
      }
      if (!rowNumber) output.push(headers.map(formatInline).join(' / '));
      blank();
      continue;
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const setext = !/^\s*>/.test(line) && i + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i + 1]);
    if (heading || setext) {
      blank();
      output.push(`【${formatInline(heading?.[1] ?? line.trim())}】`);
      blank();
      if (setext && !heading) i++;
      continue;
    }
    const quote = /^ {0,3}(?:>[ \t]*)+(.*)$/.exec(line);
    output.push(quote ? `│ ${formatInline(quote[1])}` : formatInline(line));
  }
  while (output.length > preserveThrough && output.at(-1) === '') output.pop();
  return output.join('\n');
}
