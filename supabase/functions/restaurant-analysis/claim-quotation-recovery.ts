type AgentText = { id: string; text: string };
type BoldSpan = { start: number; end: number };
export type ClaimQuotationCorrection = {
  path: string; agentId: string; kind: "paired_bold_delimiters";
  originalQuotation: string; restoredQuotation: string;
};

// A deliberately small subset of Markdown, not a renderer. Unsupported syntax
// stays literal. Only complete, unescaped, two-star pairs on ordinary prose
// lines are eligible. Never normalize spaces, punctuation, digits or words.
function boldSpans(text: string): BoldSpan[] {
  const spans: BoldSpan[] = [];
  let offset = 0, fence: { char: string; length: number; prefix: string } | undefined;
  let codeTicks = 0, uncertainEmphasis = false, htmlComment = false;
  const htmlTags: string[] = [];
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
      continue;
    }
    if (!inHtml && !codeTicks && (!line.trim() || /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line))) {
      uncertainEmphasis = false;
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
    // A single-star list marker is structural, not cross-line emphasis.
    prose = prose.replace(/^ {0,3}\*(?=\s)/, value => " ".repeat(value.length));
    const runs = [...prose.matchAll(/\*+/g)];
    const local: BoldSpan[] = [];
    let valid = runs.length % 2 === 0;
    for (let i = 0; valid && i < runs.length; i += 2) {
      const open = runs[i], close = runs[i + 1];
      const start = open.index!, end = close.index!;
      const before = line[start - 1] ?? "", first = line[start + 2] ?? "";
      const last = line[end - 1] ?? "", after = line[end + 2] ?? "";
      valid = open[0] === "**" && close[0] === "**" && end > start + 2
        && prose.slice(start, end + 2) === line.slice(start, end + 2)
        && !whitespace(first) && (!punctuation(first) || whitespace(before) || punctuation(before))
        && !whitespace(last) && (!punctuation(last) || whitespace(after) || punctuation(after));
      if (valid) local.push({ start: base + start, end: base + end + 2 });
    }
    // Unsupported emphasis can continue across soft line breaks. Refuse this
    // paragraph, not unrelated blocks; never pair delimiters across lines.
    const unsupported = /^(?: {4}|\t)/.test(line) || /[\\\[\]<>]/.test(prose);
    if (!valid || /[\[\]<>]/.test(prose) || (unsupported && runs.length)) uncertainEmphasis = true;
    if (!hadCode && !hadHtml && !unsupported && !uncertainEmphasis) spans.push(...local);
  }
  return spans;
}

function projection(text: string) {
  const spans = boldSpans(text), removed = new Set<number>();
  for (const { start, end } of spans) for (const i of [start, start + 1, end - 2, end - 1]) removed.add(i);
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
    if (!touched.length || touched.some(s => start > s.start + 2 || end < s.end - 2)) continue;
    start = Math.min(start, ...touched.map(s => s.start));
    end = Math.max(end, ...touched.map(s => s.end));
    const restored = raw.slice(start, end);
    // The mapped raw interval must project back exactly, with no boundary merge.
    if (projection(restored).visible !== claim) continue;
    review.claim = restored;
    corrections.push({ path: `claimReviews[${index}].claim`, agentId: review.agentId,
      kind: "paired_bold_delimiters", originalQuotation: claim, restoredQuotation: restored });
  }
  return { report: candidate, corrections };
}
