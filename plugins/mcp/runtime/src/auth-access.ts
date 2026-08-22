export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

export type OAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
  url: string;
  instructions?: string;
};

export type OAuthSelectOption = {
  id: string;
  label: string;
};

export type OAuthSelectPrompt = {
  message: string;
  options: OAuthSelectOption[];
};

export interface OAuthLoginCallbacks {
  onAuth: (info: OAuthAuthInfo) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onSelect?: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
  signal?: AbortSignal;
}

export interface OAuthProviderInterface {
  readonly id: string;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  usesCallbackServer?: boolean;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}

export interface AuthAccess {
  getOAuthProvider(id: string): OAuthProviderInterface | undefined;
  registerOAuthProvider(provider: OAuthProviderInterface): void;
  oauthErrorHtml(message: string, details?: string): string;
  oauthSuccessHtml(message: string): string;
  generatePKCE(): Promise<{ verifier: string; challenge: string }>;
}

let authAccess: AuthAccess | undefined;

/** Inject authentication services without coupling this runtime to a concrete auth package. */
export function configureAuthAccess(access: AuthAccess): void {
  authAccess = access;
}

export function getAuthAccess(): AuthAccess {
  if (!authAccess) {
    throw new Error("MCP runtime authentication dependency is not configured");
  }
  return authAccess;
}
