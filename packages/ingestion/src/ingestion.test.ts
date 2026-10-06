import { describe, expect, it } from "vitest";
import { SourceConfig } from "@oa/shared";
import { makeUcsDocx, makeUisDocx, PNG_BLUE, PNG_RED } from "../../../test/helpers.js";
import { canonicalSection, chunkDocument, splitText } from "./chunker.js";
import { classifyDocType, detectDocTypeFromContent, extractUcId } from "./classify.js";
import { htmlToDocument } from "./parsers/docx.js";
import { toSourceItem } from "./onedrive.js";
import { parseDocument } from "./parsers/index.js";
import { inScope } from "./scope.js";

const UC_PATTERN = "UC[-_ ]?\\d{2,4}";
const RULES = [
  { type: "UIS" as const, pathPattern: "\\bUIS\\b|UI[-_ ]?Spec" },
  { type: "UCS" as const, pathPattern: "\\bUCS\\b|Use[-_ ]?Case" },
];

describe("classify", () => {
  it("normalises UC ids", () => {
    expect(extractUcId("/Specs/UCS/UC_45 Submissions.docx", UC_PATTERN)).toBe("UC-045");
    expect(extractUcId("/Specs/uc-1203 Tax.docx", UC_PATTERN)).toBe("UC-1203");
    expect(extractUcId("/Specs/Readme.docx", UC_PATTERN)).toBeNull();
  });

  it("works with the default source configuration", () => {
    const cfg = SourceConfig.parse({ name: "S", connector: "onedrive", driveId: "d" });
    expect(extractUcId("/Specs/UIS/UC-045 Monitor.docx", cfg.ucIdPattern)).toBe("UC-045");
    expect(classifyDocType("/Specs/UIS/UC-045 Monitor.docx", cfg.docTypeRules)).toBe("UIS");
    expect(classifyDocType("/Specs/UCS/UC-045 Monitor.docx", cfg.docTypeRules)).toBe("UCS");
  });

  it("classifies UCS vs UIS by path rules", () => {
    expect(classifyDocType("/Specs/UIS/UC-045 Monitor.docx", RULES)).toBe("UIS");
    expect(classifyDocType("/Specs/UCS/UC-045 Monitor.docx", RULES)).toBe("UCS");
    expect(classifyDocType("/Specs/Other/notes.docx", RULES)).toBe("OTHER");
  });
});

describe("scope", () => {
  const cfg = { folderPath: "/Specs", includeGlobs: ["**/*"], excludeGlobs: ["Archive/**"], fileTypes: ["docx", "pdf"] };

  it("keeps files inside the folder with allowed types", () => {
    expect(inScope({ path: "/Specs/UCS/UC-045.docx", isFolder: false }, cfg)).toBe(true);
    expect(inScope({ path: "/specs/UCS/UC-045.PDF", isFolder: false }, cfg)).toBe(true);
  });

  it("drops folders, other folders, other types, excludes and Office lock files", () => {
    expect(inScope({ path: "/Specs/UCS", isFolder: true }, cfg)).toBe(false);
    expect(inScope({ path: "/SpecsOld/UC-045.docx", isFolder: false }, cfg)).toBe(false);
    expect(inScope({ path: "/Specs/UC-045.xlsx", isFolder: false }, cfg)).toBe(false);
    expect(inScope({ path: "/Specs/Archive/UC-001.docx", isFolder: false }, cfg)).toBe(false);
    expect(inScope({ path: "/Specs/UCS/~$UC-045.docx", isFolder: false }, cfg)).toBe(false);
  });
});

describe("chunker", () => {
  it("maps headings to canonical UCS sections", () => {
    expect(canonicalSection("3. Main Success Scenario")).toBe("Main Flow");
    expect(canonicalSection("Pre-conditions")).toBe("Preconditions");
    expect(canonicalSection("Screen Layout")).toBeNull();
  });

  it("splits long text on paragraphs with overlap and never exceeds the limit", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(10).trim());
    const parts = splitText(paras.join("\n"), 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500);
    // last paragraph of a part is repeated at the start of the next
    expect(parts[1]!.startsWith(parts[0]!.split("\n").at(-1)!)).toBe(true);
  });
});

describe("docx parsing", () => {
  it("splits a UCS into sections, keeping lists and tables", async () => {
    const data = await makeUcsDocx({
      title: "UC-045 Monitor Submissions",
      mainFlow: ["Open Submission Monitor", "Select a batch", "Click Reprocess on failed records"],
      rules: ["BR1: Only failed records can be reprocessed."],
    });
    const doc = await parseDocument("UC-045 Monitor Submissions.docx", data);
    const chunks = chunkDocument(doc, "UC-045", "UCS");

    expect(doc.title).toBe("UC-045 Monitor Submissions");
    expect(chunks.map((c) => c.section)).toEqual(["Overview", "Main Flow", "Business Rules", "Data Fields"]);
    expect(chunks.find((c) => c.section === "Main Flow")!.text).toContain("Click Reprocess on failed records");
    expect(chunks.find((c) => c.section === "Data Fields")!.text).toContain("Pass Count | Records that passed validation");
    expect(new Set(chunks.map((c) => c.textHash)).size).toBe(chunks.length);
  });

  it("attaches UIS screenshots to the screen section they appear in", async () => {
    const data = await makeUisDocx({
      title: "UC-045 Monitor Submissions UI",
      screens: [
        { name: "Submission Monitor", text: "Shows pass, fail and total counts per batch.", image: PNG_RED },
        { name: "Reprocess Dialog", text: "Confirms reprocessing of failed records.", image: PNG_BLUE },
      ],
    });
    const doc = await parseDocument("UC-045 UIS.docx", data);
    const screens = doc.sections.filter((s) => s.images.length);

    expect(screens.map((s) => s.headingPath.at(-1))).toEqual(["Submission Monitor", "Reprocess Dialog"]);
    expect(screens[0]!.images[0]!.data.equals(PNG_RED)).toBe(true);
    expect(screens[0]!.images[0]!.caption).toContain("pass, fail and total");
    expect(chunkDocument(doc, "UC-045", "UIS").map((c) => c.section)).toEqual(["Submission Monitor", "Reprocess Dialog"]);
  });
});

describe("real-world docx formatting", () => {
  // Shapes taken from the IRAS sample specs: bold numbered headings instead of
  // Word heading styles, a heading number split into its own paragraph,
  // multi-paragraph table cells and running page footers.
  const html = [
    "<p><strong>UI Specification: mTP View Individual Tax Notices</strong></p>",
    "<p>DOCUMENT ID</p><p>UIS-MTP-TAXNOTICES-01</p>",
    "<p><strong>1</strong></p><p><strong>. DOCUMENT SCOPE &amp; OBJECTIVES</strong></p>",
    "<p>Defines the layout of the notices page.</p>",
    "<p><strong>Access Requirement: Singpass authentication.</strong></p>",
    "<h1>2. USER PERSONA</h1><p>Individual taxpayers.</p>",
    "<p><strong>2.1 Secondary Users</strong></p><p>Tax agents.</p>",
    "<table><tr><td><p>State Handling Rules:</p><p>Loading State: skeleton rows.</p></td><td>A<br/>B</td></tr></table>",
    "<p>UIS-MTP-TAXNOTICES-01 Page 1 of 2</p>",
  ].join("");
  const doc = htmlToDocument(html, [], "fallback");

  it("takes the title from the first line, not the first heading", () => {
    expect(doc.title).toBe("UI Specification: mTP View Individual Tax Notices");
  });

  it("treats bold numbered paragraphs as headings with nesting, but not bold sentences", () => {
    expect(doc.sections.map((s) => s.headingPath)).toEqual([
      [],
      ["1. DOCUMENT SCOPE & OBJECTIVES"],
      ["2. USER PERSONA"],
      ["2. USER PERSONA", "2.1 Secondary Users"],
    ]);
    expect(doc.sections[1]!.text).toContain("Access Requirement: Singpass authentication.");
  });

  it("keeps line breaks inside table cells and drops page footers", () => {
    const last = doc.sections.at(-1)!.text;
    expect(last).toContain("State Handling Rules:; Loading State: skeleton rows. | A; B");
    expect(last).not.toContain("Page 1 of 2");
  });

  it("names the header block Document Info", () => {
    expect(chunkDocument(doc, null, "UIS")[0]!.section).toBe("Document Info");
  });
});

describe("document type from content", () => {
  const docWith = (title: string, header = "") => ({ title, sections: [{ headingPath: [], text: header, images: [] }] });

  it("reads the type from the title or header block", () => {
    expect(detectDocTypeFromContent(docWith("UI Specification: mTP View Individual Tax Notices"))).toBe("UIS");
    expect(detectDocTypeFromContent(docWith("User Interface Specification (UIS)"))).toBe("UIS");
    expect(detectDocTypeFromContent(docWith("UC-045", "Use Case Specification\nVersion 1.2"))).toBe("UCS");
    expect(detectDocTypeFromContent(docWith("Release notes"))).toBeNull();
  });

  it("uses whichever phrase comes first, so a UCS that mentions its UI spec stays a UCS", () => {
    expect(detectDocTypeFromContent(docWith("Use Case Specification: Monitor (see related UI Specification)"))).toBe("UCS");
  });
});

describe("graph mapping", () => {
  it("builds the full path from parentReference", () => {
    const item = toSourceItem({
      id: "01ABC",
      name: "UC-045 Monitor.docx",
      webUrl: "https://contoso.sharepoint.com/x",
      cTag: "c:1",
      file: {},
      parentReference: { path: "/drives/b!xyz/root:/Specs/UCS%20Docs" },
    });
    expect(item.path).toBe("/Specs/UCS Docs/UC-045 Monitor.docx");
    expect(item.isFolder).toBe(false);
    expect(toSourceItem({ id: "2", name: "Top.docx", parentReference: { path: "/drives/b!xyz/root:" } }).path).toBe("/Top.docx");
  });
});
