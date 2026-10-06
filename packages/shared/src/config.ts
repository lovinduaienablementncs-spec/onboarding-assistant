function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  get databaseUrl() { return req("DATABASE_URL"); },
  get redisUrl() { return process.env.REDIS_URL ?? "redis://localhost:6379"; },
  get tenantId() { return req("AZURE_TENANT_ID"); },
  get clientId() { return req("AZURE_CLIENT_ID"); },
  get clientSecret() { return req("AZURE_CLIENT_SECRET"); },
  get apiAudience() { return process.env.API_AUDIENCE ?? "api://onboarding-assistant"; },
  get voyageApiKey() { return req("VOYAGE_API_KEY"); },
  get embeddingModel() { return process.env.EMBEDDING_MODEL ?? "voyage-3.5"; },
  get publicBaseUrl() { return process.env.PUBLIC_BASE_URL; },
  get speechKey() { return process.env.AZURE_SPEECH_KEY; },
  get speechRegion() { return process.env.AZURE_SPEECH_REGION; },
};
