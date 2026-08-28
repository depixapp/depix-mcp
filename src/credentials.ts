// The gateway credential resolver (§3.1 / Part C). Before this, ApiClient
// captured the sk_ key ONCE at construction, so a key minted mid-session by
// register_account could not be used without restarting the process. This holder
// is the single mutable source the ApiClient reads per request, so a fresh key
// takes effect on the very next call.
//
// TWO IDENTITIES CAN COEXIST on one machine: the account the agent registered
// for itself (`register_account`, an sk_ key) and the human operator's own login
// (`depix-mcp login`, a WorkOS token). Exactly one authenticates each request,
// and the choice is never implicit:
//
//   DEPIX_API_KEY  >  an explicit `depix-mcp account use`  >  agent  >  owner
//
// The env var wins because an operator who pins a key means it. The explicit
// selection comes next because switching identity is an operator act at a
// terminal — deliberately NOT an MCP tool, so a prompt-injected agent cannot
// promote itself to the owner's login. Agent-before-owner is the default so a
// server that already had an account keeps behaving exactly as it did before
// anyone logged in.
//
// source() reports which of the four won, so register_account and
// `account status` can say WHY, instead of leaving the ambiguity silent.

import type { Persona } from "./account-preference.js";

export type { Persona };

/** How the currently-active credential was chosen. */
export type CredentialSource = "env" | "store" | "owner" | "none";

/** A resolved bearer plus what KIND it is — only an OAuth session can refresh. */
export interface ResolvedCredential {
  token: string;
  kind: "api_key" | "oauth";
}

export interface CredentialResolverOptions {
  /** DEPIX_API_KEY at boot. Immutable; always wins when present. */
  envKey?: string;
  /** The persona `account use` selected, read from disk at boot. */
  preference?: Persona;
}

export class CredentialResolver {
  private readonly envKey: string | undefined;
  /** Set by register_account after it durably persists the key. */
  private activeStoreKey: string | undefined;
  /** The operator's access token, from the encrypted owner session. */
  private ownerToken: string | undefined;
  private selected: Persona | undefined;

  constructor(opts: CredentialResolverOptions = {}) {
    this.envKey = opts.envKey && opts.envKey.length > 0 ? opts.envKey : undefined;
    this.selected = opts.preference;
  }

  /** Record the key register_account just wrote to the encrypted store. */
  setActiveKey(key: string | undefined): void {
    this.activeStoreKey = key && key.length > 0 ? key : undefined;
  }

  /** Record the owner's access token (login, or a refresh that rotated it). */
  setOwnerToken(token: string | undefined): void {
    this.ownerToken = token && token.length > 0 ? token : undefined;
  }

  /** Record the explicit `account use` selection (undefined = back to default). */
  setPreference(persona: Persona | undefined): void {
    this.selected = persona;
  }

  preference(): Persona | undefined {
    return this.selected;
  }

  hasAgentKey(): boolean {
    return this.activeStoreKey !== undefined;
  }

  hasOwnerSession(): boolean {
    return this.ownerToken !== undefined;
  }

  /** Both identities are usable — the case where the choice must be explicit. */
  bothPersonasPresent(): boolean {
    return this.hasAgentKey() && this.hasOwnerSession();
  }

  /**
   * A selection was made but that persona has no credential (a `logout` that
   * left the choice behind, a wallet dir the agent key was removed from).
   * Requests fall back rather than authenticating as nobody — but the fallback
   * stays VISIBLE: `account status` and the boot line both report it.
   */
  selectionUnavailable(): boolean {
    if (this.selected === undefined) return false;
    return this.selected === "owner" ? !this.hasOwnerSession() : !this.hasAgentKey();
  }

  /** The credential to authenticate with, and what kind it is. */
  resolveCredential(): ResolvedCredential | undefined {
    if (this.envKey !== undefined) return { token: this.envKey, kind: "api_key" };
    if (this.selected === "owner" && this.ownerToken !== undefined) {
      return { token: this.ownerToken, kind: "oauth" };
    }
    if (this.selected === "agent" && this.activeStoreKey !== undefined) {
      return { token: this.activeStoreKey, kind: "api_key" };
    }
    if (this.activeStoreKey !== undefined) return { token: this.activeStoreKey, kind: "api_key" };
    if (this.ownerToken !== undefined) return { token: this.ownerToken, kind: "oauth" };
    return undefined;
  }

  /** The bearer string alone (the pre-owner-session callers still read this). */
  resolve(): string | undefined {
    return this.resolveCredential()?.token;
  }

  /** Where the active credential came from (the register_account readout). */
  source(): CredentialSource {
    const active = this.resolveCredential();
    if (active === undefined) return "none";
    if (this.envKey !== undefined) return "env";
    return active.kind === "oauth" ? "owner" : "store";
  }

  /** Which identity the server is acting as right now. */
  persona(): Persona | "none" {
    const source = this.source();
    if (source === "none") return "none";
    if (source === "owner") return "owner";
    // An env key is an sk_ key of whichever account minted it; from this
    // process's point of view that is the agent-style identity.
    return "agent";
  }

  /** The env key present (from boot), regardless of what the store holds. */
  envKeyPresent(): boolean {
    return this.envKey !== undefined;
  }

  /** True when an env key is shadowing a credential that would otherwise win. */
  hasEnvOverride(): boolean {
    return this.envKey !== undefined && (this.hasAgentKey() || this.hasOwnerSession());
  }

  /** A bound resolver to hand to ApiClient / CreateServerOptions. */
  asFunction(): () => ResolvedCredential | undefined {
    return () => this.resolveCredential();
  }
}
