import { PublicClientApplication, type AccountInfo } from "@azure/msal-browser";

interface PublicConfig {
  authMode: "dev" | "entra";
  tenantId?: string;
  clientId?: string;
  apiScope?: string;
}

let config: PublicConfig;
let msal: PublicClientApplication | undefined;
let account: AccountInfo | undefined;

/** Loads sign-in settings from the API and, for Entra, completes or starts the login redirect. */
export async function initAuth(): Promise<void> {
  config = (await (await fetch("/api/config")).json()) as PublicConfig;
  if (config.authMode !== "entra") return;

  msal = new PublicClientApplication({
    auth: {
      clientId: config.clientId!,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: "sessionStorage" },
  });
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  account = result?.account ?? msal.getAllAccounts()[0];
  if (!account) await msal.loginRedirect({ scopes: [config.apiScope!] });
}

export async function getToken(): Promise<string> {
  if (config.authMode !== "entra") return "local-dev";
  try {
    const res = await msal!.acquireTokenSilent({ scopes: [config.apiScope!], account: account! });
    return res.accessToken;
  } catch {
    await msal!.acquireTokenRedirect({ scopes: [config.apiScope!], account });
    throw new Error("Redirecting to sign in");
  }
}

export async function signOut(): Promise<void> {
  if (msal && account) await msal.logoutRedirect({ account });
}

export const isDevAuth = () => config.authMode !== "entra";
