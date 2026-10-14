import type { SourceStructure } from "../completion/structure";

/** A NatSpec comment, tag by tag. Text without a tag is `@notice`. */
export interface NatSpec {
  readonly title?: string;
  readonly author?: string;
  readonly notice?: string;
  readonly dev?: string;
  readonly params: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  /** `@return` tags in order; `name` when the text starts with the name of a named return. */
  readonly returns: ReadonlyArray<{ readonly name?: string; readonly text: string }>;
  /** `@inheritdoc Base`. */
  readonly inheritdoc?: string;
  /** `@custom:name text`. */
  readonly custom: ReadonlyArray<{ readonly tag: string; readonly text: string }>;
}

/**
 * The NatSpec comment right before `start`: consecutive `///` lines or one `/** *\/`
 * block, with nothing but whitespace in between. Plain comments end the search.
 */
export function docCommentBefore(structure: SourceStructure, start: number): string | undefined {
  const { text, trivia } = structure;
  const lines: string[] = [];
  let end = start;
  for (let k = lastTriviaBefore(trivia, start); k >= 0; k--) {
    const c = trivia[k]!;
    if (c.kind === "string" || text.slice(c.end, end).trim() !== "") break;
    const comment = text.slice(c.start, c.end);
    if (comment.startsWith("///")) {
      lines.unshift(comment.slice(3));
      end = c.start;
      continue;
    }
    // A `/** */` block is a doc comment on its own, not continued by `///` lines.
    if (comment.startsWith("/**") && !comment.startsWith("/**/") && lines.length === 0) {
      return comment
        .slice(3, c.terminated ? -2 : undefined)
        .split("\n")
        .map((l) => l.replace(/^\s*\*(?!\*)\s?/, "").replace(/^\s+/, ""))
        .join("\n");
    }
    break;
  }
  return lines.length ? lines.map((l) => l.replace(/^ /, "")).join("\n") : undefined;
}

function lastTriviaBefore(trivia: SourceStructure["trivia"], offset: number): number {
  let lo = 0;
  let hi = trivia.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trivia[mid]!.end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Splits a doc comment into its tags. `returnNames` lets `@return amount ...` be matched to a named return. */
export function parseNatSpec(comment: string, returnNames: readonly string[] = []): NatSpec {
  const tags: Array<{ tag: string; text: string }> = [];
  let current = { tag: "notice", text: "" };
  for (const line of comment.split("\n")) {
    const m = /^\s*@([\w:-]+)\s?(.*)$/.exec(line);
    if (m) {
      tags.push(current);
      current = { tag: m[1]!, text: m[2]! };
    } else {
      current.text += `\n${line}`;
    }
  }
  tags.push(current);

  const out: { -readonly [K in keyof NatSpec]: NatSpec[K] } = { params: [], returns: [], custom: [] };
  const params: Array<{ name: string; text: string }> = [];
  const returns: Array<{ name?: string; text: string }> = [];
  const custom: Array<{ tag: string; text: string }> = [];
  const append = (prev: string | undefined, text: string) => (prev ? `${prev}\n\n${text}` : text);
  for (const { tag, text: raw } of tags) {
    const text = tidy(raw);
    if (!text && tag !== "notice") continue;
    switch (tag) {
      case "notice":
        if (text) out.notice = append(out.notice, text);
        break;
      case "dev":
        out.dev = append(out.dev, text);
        break;
      case "title":
        out.title = text;
        break;
      case "author":
        out.author = text;
        break;
      case "inheritdoc":
        out.inheritdoc = text.split(/\s/)[0];
        break;
      case "param": {
        const m = /^([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(text);
        if (m) params.push({ name: m[1]!, text: m[2]! });
        break;
      }
      case "return": {
        const m = /^([A-Za-z_$][\w$]*)\s+([\s\S]*)$/.exec(text);
        if (m && returnNames.includes(m[1]!)) returns.push({ name: m[1]!, text: m[2]! });
        else returns.push({ text });
        break;
      }
      default:
        if (tag.startsWith("custom:")) custom.push({ tag, text });
    }
  }
  return { ...out, params, returns, custom };
}

/** Trims every line and joins paragraphs, keeping blank lines as paragraph breaks. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown for a declaration's NatSpec. */
export function renderNatSpec(n: NatSpec): string | undefined {
  const parts: string[] = [];
  if (n.title) parts.push(`**${n.title}**`);
  if (n.notice) parts.push(n.notice);
  if (n.dev) parts.push(n.dev);
  if (n.params.length) parts.push(n.params.map((p) => `*@param* \`${p.name}\`${p.text ? ` — ${p.text}` : ""}`).join("  \n"));
  if (n.returns.length) parts.push(n.returns.map((r) => `*@return* ${r.name ? `\`${r.name}\` — ` : ""}${r.text}`).join("  \n"));
  for (const c of n.custom) parts.push(`*@${c.tag}* ${c.text}`);
  if (n.author) parts.push(`*@author* ${n.author}`);
  return parts.length ? parts.join("\n\n") : undefined;
}
