import { inflateSync } from "node:zlib";

/**
 * Automated structural PDF/UA-1 checker (issue #773) for the PDFs this app
 * writes. It covers the machine-checkable Matterhorn Protocol checkpoints
 * relevant to our output: tagged + marked, document language, title shown
 * from metadata, PDF/UA identifier in XMP, embedded fonts, alt text on
 * figures, every page tagged with tab order, and no untagged content.
 * Returns a list of failures (empty = pass).
 */
export function checkPdfUa(pdf: Buffer): string[] {
  const failures: string[] = [];
  const src = pdf.toString("latin1");
  const objects = new Map<number, { dict: string; stream: Buffer | null }>();
  const re = /(\d+) 0 obj\n([\s\S]*?)\nendobj/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const body = m[2];
    const si = body.indexOf("stream\n");
    if (si >= 0) {
      const dict = body.slice(0, si);
      const start = m.index + m[0].indexOf(body) + si + 7;
      const len = Number(
        /\/Length (\d+)/.exec(dict.replace(/\/Length1 \d+/, ""))?.[1],
      );
      const raw = pdf.subarray(start, start + len);
      objects.set(Number(m[1]), {
        dict,
        stream: /\/FlateDecode/.test(dict) ? inflateSync(raw) : raw,
      });
    } else {
      objects.set(Number(m[1]), { dict: body, stream: null });
    }
  }
  const all = [...objects.values()];
  const catalog = all.find((o) => /\/Type \/Catalog/.test(o.dict))?.dict ?? "";

  if (!/\/MarkInfo << \/Marked true >>/.test(catalog))
    failures.push("Catalog: MarkInfo/Marked not true");
  if (!/\/Lang \([A-Za-z-]+\)/.test(catalog))
    failures.push("Catalog: missing /Lang");
  if (!/\/StructTreeRoot \d+ 0 R/.test(catalog))
    failures.push("Catalog: missing StructTreeRoot");
  if (!/\/DisplayDocTitle true/.test(catalog))
    failures.push("Catalog: DisplayDocTitle not true");

  const metaRef = /\/Metadata (\d+) 0 R/.exec(catalog)?.[1];
  const xmp = metaRef
    ? (objects.get(Number(metaRef))?.stream?.toString("utf8") ?? "")
    : "";
  if (!/<pdfuaid:part>1<\/pdfuaid:part>/.test(xmp))
    failures.push("XMP: missing pdfuaid:part=1");
  if (!/<dc:title>[\s\S]*<rdf:li[^>]*>[^<]+<\/rdf:li>/.test(xmp))
    failures.push("XMP: missing dc:title");

  for (const o of all.filter((x) => /\/Type \/Font\b/.test(x.dict))) {
    const desc = /\/FontDescriptor (\d+) 0 R/.exec(o.dict)?.[1];
    const d = desc ? objects.get(Number(desc))?.dict : undefined;
    if (!d || !/\/FontFile[23]? \d+ 0 R/.test(d))
      failures.push("Font: not embedded");
  }

  const elems = all.filter((o) => /\/Type \/StructElem/.test(o.dict));
  for (const e of elems) {
    if (/\/S \/Figure/.test(e.dict) && !/\/Alt \(.+?\)/.test(e.dict)) {
      failures.push("Figure: missing /Alt");
    }
  }

  for (const page of all.filter((o) => /\/Type \/Page\b/.test(o.dict))) {
    if (!/\/StructParents \d+/.test(page.dict))
      failures.push("Page: missing StructParents");
    if (!/\/Tabs \/S/.test(page.dict)) failures.push("Page: Tabs is not /S");
    const contentRef = /\/Contents (\d+) 0 R/.exec(page.dict)?.[1];
    const content =
      objects.get(Number(contentRef))?.stream?.toString("latin1") ?? "";
    // Strip tagged and artifact sequences; nothing that paints may remain.
    const leftover = content
      .replace(/\/\w+ <<\/MCID \d+>> BDC[\s\S]*?EMC/g, "")
      .replace(/\/Artifact BMC[\s\S]*?EMC/g, "");
    if (/\b(Tj|TJ|re|f|S|Do)\b/.test(leftover))
      failures.push("Page: untagged content");
  }
  return failures;
}

/** Structure-element tags in reading (structure tree) order. */
export function readingOrder(pdf: Buffer): string[] {
  const src = pdf.toString("latin1");
  const doc = /\/S \/Document [^]*?\/K \[([^\]]*)\]/.exec(src)?.[1] ?? "";
  return [...doc.matchAll(/(\d+) 0 R/g)].map((r) => {
    const obj = new RegExp(`\\n${r[1]} 0 obj\\n([^\\n]*)`).exec(src)?.[1] ?? "";
    return /\/S \/(\w+)/.exec(obj)?.[1] ?? "?";
  });
}
