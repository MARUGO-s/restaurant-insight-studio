type AgentText = { id: string; text: string };
type EmphasisSpan = { start: number; end: number; width: number };
export type ClaimQuotationCorrection = {
  path: string; agentId: string; kind: "paired_bold_delimiters" | "paired_emphasis_delimiters";
  originalQuotation: string; restoredQuotation: string;
};

// A deliberately small subset of Markdown, not a renderer. Unsupported syntax
// stays literal. Only complete, unescaped, one/two-star pairs on ordinary prose
// lines are eligible. Never normalize spaces, punctuation, digits or words.
function emphasisSpans(text: string): EmphasisSpan[] {
  const spans: EmphasisSpan[] = [];
  let offset = 0, fence: { char: string; length: number; prefix: string } | undefined;
  let codeTicks = 0, uncertainEmphasis = false, htmlComment = false;
  const htmlTags: string[] = [];
  // Only contiguous, proven ASCII list items establish container indentation.
  // Blank/protected/unsupported lines discard the proof: this is not a full
  // Markdown block parser and must not guess at lazy or loose continuations.
  const listParents: { indent: number; contentIndent: number }[] = [];
  const whitespace = (c: string) => !c || /\s/u.test(c);
  const punctuation = (c: string) => /[\p{P}\p{S}]/u.test(c);
  for (const line of text.split("\n")) {
    const base = offset;
    offset += line.length + 1;
    // A fence can begin after list/blockquote containers, including nested
    // lists. Keep their code literal; detecting only column-zero fences lets
    // a two-space list continuation masquerade as ordinary prose.
    const opening = /^([ \t]*(?:(?:>[ \t]*|(?:[-+*]|\d{1,9}[.)])[ \t]+)[ \t]*)*)(`{3,}|~{3,})/.exec(line);
    const prefix = opening?.[1] ?? "", marker = opening?.[2];
    if (fence) {
      // List markers on a code line are literal, not a closing container.
      // Require the opener's continuation prefix (or ordinary 0–3 spaces).
      // Uncertain container layouts stay protected rather than closing early.
      const samePrefix = prefix === fence.prefix || (/^ {0,3}$/.test(prefix) && /^ {0,3}$/.test(fence.prefix));
      // Only ASCII space/tab may follow a closer; split("\n") retains the
      // terminal CR of CRLF. Unicode whitespace is literal code, not padding.
      if (marker?.[0] === fence.char && marker.length >= fence.length && samePrefix
        && /^[ \t]*\r?$/.test(line.slice(prefix.length + marker.length))) fence = undefined;
      continue;
    }
    const inHtml = htmlComment || htmlTags.length > 0;
    if (!inHtml && !codeTicks && marker) {
      fence = { char: marker[0], length: marker.length,
        prefix: prefix.replace(/(?:[-+*]|\d{1,9}[.)])(?=[ \t])/g, value => " ".repeat(value.length)) };
      uncertainEmphasis = false;
      listParents.length = 0;
      continue;
    }
    if (!inHtml && !codeTicks && (!line.trim() || /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line))) {
      uncertainEmphasis = false;
      listParents.length = 0;
      continue;
    }
    // Scan left-to-right so ticks inside URLs/links cannot start code, and
    // links inside code cannot hide its closing ticks. A code-affected line
    // stays literal, including prose on either side of the code span.
    let prose = "", hadCode = codeTicks > 0, hadHtml = inHtml;
    for (let i = 0; i < line.length;) {
      const rest = line.slice(i);
      const ticks = /^`+/.exec(rest)?.[0];
      const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])[^>]*>/.exec(rest);
      if (htmlComment) {
        const length = rest.startsWith("-->") ? 3 : 1;
        if (length === 3) htmlComment = false;
        prose += " ".repeat(length); i += length;
      } else if (!codeTicks && rest.startsWith("<!--")) {
        htmlComment = true; hadHtml = true;
        prose += "    "; i += 4;
      } else if (!codeTicks && tag) {
        hadHtml = true;
        const name = tag[1].toLowerCase();
        if (tag[0].startsWith("</")) {
          if (htmlTags.at(-1) === name) htmlTags.pop();
        } else if (!tag[0].endsWith("/>") && !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)) {
          htmlTags.push(name);
        }
        prose += " ".repeat(tag[0].length); i += tag[0].length;
      } else if (htmlTags.length) {
        prose += " "; i++;
      } else if (!codeTicks && /^<[/!?A-Za-z]/.test(rest) && !rest.includes(">")) {
        // A split/unfinished HTML tag has no safe line-local boundary. Keep
        // the remaining context literal rather than resuming at a blank line.
        return spans;
      } else if (codeTicks) {
        if (ticks?.length === codeTicks) codeTicks = 0;
        const length = ticks?.length ?? 1;
        prose += " ".repeat(length); i += length;
      } else {
        const protectedText = /^!?\[[^\[\]\n]*\]\((?:[^()\\\n]|\\.)*\)/.exec(rest)?.[0]
          ?? /^(?:[a-z][a-z0-9+.-]*:|\/\/|www\.)[^\s<>]*/i.exec(rest)?.[0];
        if (protectedText) {
          prose += " ".repeat(protectedText.length); i += protectedText.length;
        } else if (line[i] === "\\") {
          // Escaped ticks are literal outside code (inside code, they close it).
          prose += line.slice(i, i + 2); i += 2;
        } else if (ticks) {
          codeTicks = ticks.length; hadCode = true;
          prose += " ".repeat(ticks.length); i += ticks.length;
        } else {
          prose += line[i++];
        }
      }
    }
    // A marker is eligible at 0–3 columns of its proven parent's content,
    // never at four relative columns (indented code). Pop siblings/dedents,
    // but do not treat a position inside an item's marker padding as a parent.
    const item = /^( *)([-+*]|\d{1,9}[.)])( {1,4})(?=\S)/.exec(line);
    // Same-line nested markers need their own block parsing; in particular
    // `- -     text` is code, not prose in the first item's container.
    const compoundItem = !!item && /^(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(line.slice(item[0].length));
    let provenItem = false;
    if (item && !compoundItem && !hadCode && !hadHtml && !uncertainEmphasis && !/[\\\[\]<>]/.test(prose)) {
      const indent = item[1].length;
      while (listParents.length && indent <= listParents.at(-1)!.indent) listParents.pop();
      const relative = indent - (listParents.at(-1)?.contentIndent ?? 0);
      provenItem = relative >= 0 && relative <= 3;
      if (provenItem) listParents.push({ indent, contentIndent: item[0].length });
    }
    if (!provenItem) listParents.length = 0;
    // Inspect raw padding, never a projection where a URL becomes spaces.
    // Preserve the marker itself in visible text; mask it only for pairing.
    const listMarker = provenItem && item?.[2] === "*" ? item[1] + "*"
      : /^ {0,3}\*(?=[ \t])/.exec(line)?.[0];
    if (listMarker) prose = " ".repeat(listMarker.length) + prose.slice(listMarker.length);
    const runs = [...prose.matchAll(/\*+/g)];
    const local: EmphasisSpan[] = [];
    let valid = runs.length % 2 === 0;
    for (let i = 0; valid && i < runs.length; i += 2) {
      const open = runs[i], close = runs[i + 1];
      const start = open.index!, end = close.index!, width = open[0].length;
      // Flanking is defined on Unicode code points, while spans/projections
      // must retain UTF-16 offsets for matchAll, slice and exact raw mapping.
      const preceding = (index: number) => line.slice(Math.max(0, index - 2), index).match(/.$/su)?.[0] ?? "";
      const following = (index: number) => {
        const point = line.codePointAt(index);
        return point === undefined ? "" : String.fromCodePoint(point);
      };
      const before = preceding(start), first = following(start + width);
      const last = preceding(end), after = following(end + width);
      valid = (width === 1 || width === 2) && close[0].length === width && end > start + width
        && prose.slice(start, end + width) === line.slice(start, end + width)
        && !whitespace(first) && (!punctuation(first) || whitespace(before) || punctuation(before))
        && !whitespace(last) && (!punctuation(last) || whitespace(after) || punctuation(after));
      if (valid) local.push({ start: base + start, end: base + end + width, width });
    }
    // Unsupported emphasis can continue across soft line breaks. Refuse this
    // paragraph, not unrelated blocks; never pair delimiters across lines.
    const unsupported = compoundItem || (/^(?: {4}|\t)/.test(line) && !provenItem)
      || (!item && /^ *(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(line))
      || /[\\\[\]<>]/.test(prose);
    if (!valid || /[\[\]<>]/.test(prose) || (unsupported && runs.length)) uncertainEmphasis = true;
    if (uncertainEmphasis || unsupported) listParents.length = 0;
    if (!hadCode && !hadHtml && !unsupported && !uncertainEmphasis) spans.push(...local);
  }
  return spans;
}

function projection(text: string) {
  const spans = emphasisSpans(text), removed = new Set<number>();
  for (const { start, end, width } of spans) for (let i = 0; i < width; i++) {
    removed.add(start + i); removed.add(end - 1 - i);
  }
  const positions: number[] = [];
  let visible = "";
  for (let i = 0; i < text.length; i++) if (!removed.has(i)) { positions.push(i); visible += text[i]; }
  return { visible, positions, spans };
}

// Only for rejecting literal contradictions, never for accepting evidence.
export function visibleClaimText(text: string): string { return projection(text).visible; }

export function recoverClaimQuotations(report: Record<string, any>, agents: AgentText[]) {
  const candidate = structuredClone(report), corrections: ClaimQuotationCorrection[] = [];
  if (!Array.isArray(candidate.claimReviews)) return { report: candidate, corrections };
  for (const [index, review] of candidate.claimReviews.entries()) {
    if (!review || typeof review.claim !== "string" || !review.claim.trim()) continue;
    const matchingAgents = agents.filter(a => a.id === review.agentId);
    if (matchingAgents.length !== 1) continue;
    const raw = matchingAgents[0].text, claim = review.claim;
    if (raw.includes(claim)) continue;
    const { visible, positions, spans } = projection(raw);
    const at = visible.indexOf(claim);
    if (at < 0 || visible.indexOf(claim, at + 1) >= 0) continue;
    let start = positions[at], end = positions[at + claim.length - 1] + 1;
    const touched = spans.filter(s => s.start < end && s.end > start);
    if (!touched.length || touched.some(s => start > s.start + s.width || end < s.end - s.width)) continue;
    start = Math.min(start, ...touched.map(s => s.start));
    end = Math.max(end, ...touched.map(s => s.end));
    const restored = raw.slice(start, end);
    // The mapped raw interval must project back exactly, with no boundary merge.
    if (projection(restored).visible !== claim) continue;
    review.claim = restored;
    corrections.push({ path: `claimReviews[${index}].claim`, agentId: review.agentId,
      kind: touched.some(s => s.width === 1) ? "paired_emphasis_delimiters" : "paired_bold_delimiters",
      originalQuotation: claim, restoredQuotation: restored });
  }
  return { report: candidate, corrections };
}
