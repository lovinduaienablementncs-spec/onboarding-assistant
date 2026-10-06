/**
 * Writes one sample UCS and its UIS into a folder for a local smoke test.
 * Run: npx tsx scripts/make-sample-docs.ts C:/Users/LENOVO/OnboardingDocs
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeUcsDocx, makeUisDocx, PNG_BLUE, PNG_RED } from "../test/helpers.js";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: make-sample-docs.ts <folder>");

await writeFile(
  join(dir, "UCS", "UC-900 SAMPLE Monitor Submissions.docx"),
  await makeUcsDocx({
    title: "UC-900 SAMPLE Monitor Submissions",
    mainFlow: [
      "The user opens Submissions > Submission Monitor.",
      "The system lists batches with Total, Pass and Fail record counts.",
      "The user selects a batch with failed records.",
      "The user clicks Reprocess Failed and confirms.",
      "The system queues the failed records for reprocessing and shows status In Progress.",
    ],
    rules: ["BR1: Only records with status Fail can be reprocessed.", "BR2: A batch can be reprocessed at most 3 times."],
  }),
);

await writeFile(
  join(dir, "UIS", "UC-900 SAMPLE Monitor Submissions UIS.docx"),
  await makeUisDocx({
    title: "UC-900 SAMPLE Monitor Submissions UI",
    screens: [
      { name: "Submission Monitor", text: "Grid of batches with Total, Pass and Fail counts and a Reprocess Failed button.", image: PNG_RED },
      { name: "Reprocess Confirmation", text: "Dialog asking the user to confirm reprocessing of failed records.", image: PNG_BLUE },
    ],
  }),
);

console.log(`Sample documents written to ${dir}`);
