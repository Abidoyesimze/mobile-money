/**
 * BaseProvider — core authentication configuration class
 *
 * Centralises the credential/auth-header logic that was previously
 * duplicated across every provider (MTN, Airtel, Orange).
 *
 * All provider classes extend this class to inherit:
 *   - A unified credentials signature (`ProviderCredentials`)
 *   - `buildBasicAuthHeader(key, secret)` — constructs the RFC 7617
 *     Base64-encoded Basic auth string used for OAuth2 token requests
 *   - `buildBearerAuthHeader(token)` — constructs Bearer auth strings
 *     for API calls made after token exchange
 *   - `buildOAuth2TokenRequestHeaders()` — returns the complete header
 *     object required by every provider's token endpoint
 *   - `getAccessToken()` — abstract hook for subclasses to implement
 *     their own token-fetch / refresh logic
 *   - Simple in-memory token cache (`cachedToken` / `tokenExpiresAt`)
 *     with a configurable leeway to avoid using tokens right at expiry
 */

export interface ProviderCredentials {
  /** OAuth2 client ID / API key */
  apiKey: string;
  /** OAuth2 client secret / API secret */
  apiSecret: string;
}

export interface ProviderAuthConfig extends ProviderCredentials {
  /** Base URL for this provider's API */
  baseUrl: string;
  /** HTTP timeout in milliseconds (default: 10 000) */
  timeoutMs?: number;
  /**
   * Seconds before token expiry at which the token is considered stale
   * and will be refreshed proactively (default: 30)
   */
  tokenExpiryLeewaySeconds?: number;
}

export abstract class BaseProvider {
  protected readonly apiKey: string;
  protected readonly apiSecret: string;
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  /** Epoch-ms timestamp after which the cached token must be refreshed. */
  protected tokenExpiresAt: number = 0;
  /** In-memory cached access token. */
  protected cachedToken: string | null = null;

  private readonly tokenExpiryLeewayMs: number;

  constructor(config: ProviderAuthConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.tokenExpiryLeewayMs = (config.tokenExpiryLeewaySeconds ?? 30) * 1_000;
  }

  // ─── Credential / header helpers ─────────────────────────────────────────

  /**
   * Build an RFC 7617 Basic authorization header value from an API key
   * and secret pair.
   *
   * Result: `"Basic <base64(key:secret)>"`
   *
   * @param key    API key / client ID
   * @param secret API secret / client secret
   */
  protected buildBasicAuthHeader(key: string, secret: string): string {
    const credentials = Buffer.from(`${key}:${secret}`).toString("base64");
    return `Basic ${credentials}`;
  }

  /**
   * Build a Bearer authorization header value from an access token.
   *
   * Result: `"Bearer <token>"`
   *
   * @param token OAuth2 access token
   */
  protected buildBearerAuthHeader(token: string): string {
    return `Bearer ${token}`;
  }

  /**
   * Returns a ready-to-use header object for posting to an OAuth2 token
   * endpoint that expects Basic authentication.
   *
   * Uses the instance's own `apiKey` / `apiSecret` credentials.
   */
  protected buildOAuth2TokenRequestHeaders(): Record<string, string> {
    return {
      Authorization: this.buildBasicAuthHeader(this.apiKey, this.apiSecret),
      "Content-Type": "application/json",
    };
  }

  // ─── Token cache helpers ──────────────────────────────────────────────────

  /**
   * Returns `true` when the cached token is present and not yet stale
   * (accounting for the configured leeway).
   */
  protected isTokenValid(): boolean {
    return (
      this.cachedToken !== null &&
      Date.now() < this.tokenExpiresAt - this.tokenExpiryLeewayMs
    );
  }

  /**
   * Stores a new access token and sets its expiry from the provider's
   * `expires_in` value (in seconds).
   *
   * @param token     Access token string
   * @param expiresIn Lifetime in seconds as reported by the token endpoint
   */
  protected cacheToken(token: string, expiresIn: number): void {
    this.cachedToken = token;
    this.tokenExpiresAt = Date.now() + expiresIn * 1_000;
  }

  /** Evicts the cached token, forcing the next call to re-authenticate. */
  protected invalidateToken(): void {
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }

  // ─── Abstract hook ────────────────────────────────────────────────────────

  /**
   * Obtain a valid access token for the provider — either from cache or
   * by performing a fresh token exchange.
   *
   * Subclasses must implement this method.
   */
  abstract getAccessToken(): Promise<string>;
}
