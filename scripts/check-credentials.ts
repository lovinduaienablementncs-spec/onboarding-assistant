/**
 * Verifies the credentials in .env without printing any secret values.
 * Run: npx tsx --env-file=.env scripts/check-credentials.ts
 */
import { ClientSecretCredential } from "@azure/identity";

const ok = (msg: string) => console.log(`  OK    ${msg}`);
const fail = (msg: string) => console.log(`  FAIL  ${msg}`);

function decodeRoles(token: string): string[] {
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
  return payload.roles ?? [];
}

console.log("Entra / Microsoft Graph");
const { AZURE_TENANT_ID: tenant, AZURE_CLIENT_ID: client, AZURE_CLIENT_SECRET: secret, API_AUDIENCE: audience } = process.env;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
guid.test(tenant ?? "") ? ok("AZURE_TENANT_ID is a GUID") : fail("AZURE_TENANT_ID should be the Directory (tenant) ID GUID");
guid.test(client ?? "") ? ok("AZURE_CLIENT_ID is a GUID") : fail("AZURE_CLIENT_ID should be the Application (client) ID GUID");
if (guid.test(secret ?? "")) fail("AZURE_CLIENT_SECRET looks like a GUID: that is the secret ID, use the secret *Value*");
audience === `api://${client}`
  ? ok("API_AUDIENCE matches api://<client id>")
  : console.log(`  WARN  API_AUDIENCE is not api://<AZURE_CLIENT_ID>; fine only if your Application ID URI is different`);

try {
  const cred = new ClientSecretCredential(tenant!, client!, secret!);
  const token = await cred.getToken("https://graph.microsoft.com/.default");
  ok("got an app-only Graph token");
  const roles = decodeRoles(token.token);
  console.log(`        Graph application permissions granted: ${roles.length ? roles.join(", ") : "(none)"}`);
  if (!roles.some((r) => ["Sites.Selected", "Files.Read.All", "Sites.Read.All"].includes(r))) {
    fail("no Sites.Selected / Files.Read.All / Sites.Read.All application permission with admin consent");
  }

  const res = await fetch("https://graph.microsoft.com/v1.0/sites?search=*&$top=5&$select=id,displayName,webUrl", {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (res.ok) {
    const { value } = (await res.json()) as { value: Array<{ displayName: string; webUrl: string }> };
    ok(`site search works, ${value.length} site(s) visible:`);
    for (const s of value) console.log(`        - ${s.displayName}  ${s.webUrl}`);
  } else {
    console.log(`  INFO  site search returned ${res.status} (expected with Sites.Selected; a site URL is needed instead)`);
  }
} catch (err) {
  fail(`could not get a Graph token: ${(err as Error).message.split("\n")[0]}`);
}

console.log("Voyage AI");
try {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: ["credential check"], model: process.env.EMBEDDING_MODEL ?? "voyage-3.5", input_type: "query" }),
  });
  if (res.ok) {
    const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const dim = body.data[0]!.embedding.length;
    dim === 1024 ? ok(`embedding works (dimension ${dim})`) : fail(`embedding dimension is ${dim}, the schema expects 1024`);
  } else {
    fail(`Voyage returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
} catch (err) {
  fail(`Voyage request failed: ${(err as Error).message}`);
}
