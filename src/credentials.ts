// The gateway credential resolver (§3.1 / Part C). Before this, ApiClient
// captured the sk_ key ONCE at construction, so a key minted mid-session by
// register_account could not be used without restarting the process. This holder
// is the single mutable source the ApiClient reads per request, so a fresh key
// takes effect on the very next call.
//
// PRECEDENCE (§3.1, "achado m4"): DEPIX_API_KEY from the environment WINS over a
// key written to the encrypted store. That is deliberate — an operator who pins a
// key in the env means it — but it also means register_account can mint account B
// while every later call still operates account A of the env. So the resolver
// exposes hasEnvOverride()/source() and register_account reports, loudly, which
// key is actually active.

/** How the currently-active key was chosen. */
export type CredentialSource = "env" | "store" | "none";

export interface CredentialResolverOptions {
  /** DEPIX_API_KEY at boot. Immutable; always wins when present. */
  envKey?: string;
}

export class CredentialResolver {
  private readonly envKey: string | undefined;
  /** Set by register_account after it durably persists the key. */
  private activeStoreKey: string | undefined;

  constructor(opts: CredentialResolverOptions = {}) {
    this.envKey = opts.envKey && opts.envKey.length > 0 ? opts.envKey : undefined;
  }

  /** Record the key register_account just wrote to the encrypted store. */
  setActiveKey(key: string | undefined): void {
    this.activeStoreKey = key && key.length > 0 ? key : undefined;
  }

  /** The key to authenticate with: env first, then the stored key. */
  resolve(): string | undefined {
    return this.envKey ?? this.activeStoreKey;
  }

  /** Where the active key came from (for the register_account readout). */
  source(): CredentialSource {
    if (this.envKey !== undefined) return "env";
    if (this.activeStoreKey !== undefined) return "store";
    return "none";
  }

  /** The env key present (from boot), regardless of what the store holds. */
  envKeyPresent(): boolean {
    return this.envKey !== undefined;
  }

  /** True when an env key is shadowing a store key that was just written. */
  hasEnvOverride(): boolean {
    return this.envKey !== undefined && this.activeStoreKey !== undefined;
  }

  /** A bound resolver function to hand to ApiClient / CreateServerOptions. */
  asFunction(): () => string | undefined {
    return () => this.resolve();
  }
}
