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

/** The facts the persona ladder decides on. No tokens — just what EXISTS. */
export interface PersonaFacts {
  envKeyPresent: boolean;
  hasAgent: boolean;
  hasOwner: boolean;
  preference?: Persona;
}

/** WHY the active identity won — the machine-readable half of the verdict. */
export type PersonaBasis =
  | "env"
  | "env_override"
  | "selection"
  | "selection_unavailable"
  | "default"
  | "none";

export interface PersonaVerdict {
  active: Persona | "none";
  basis: PersonaBasis;
  /** One sentence, shared verbatim by the boot line and `account status`. */
  reason: string;
}

/**
 * THE ladder. Every surface that names an active identity calls this — the
 * resolver that picks the credential, the boot line, and `account status`.
 *
 * It exists because those surfaces each had their own copy. The boot line's
 * copy glued "which persona" to "was a preference set" without asking whether
 * the preference had decided anything, so DEPIX_API_KEY plus `account use
 * owner` printed "acting as the agent account (selected with `account use
 * owner`)" — wrong about the winner, wrong about the reason, and contradicting
 * `account status` on the same machine.
 */
export function decidePersona(facts: PersonaFacts): PersonaVerdict {
  const { envKeyPresent, hasAgent, hasOwner, preference } = facts;

  if (envKeyPresent) {
    // An env sk_ key is an account-style identity, whoever minted it.
    const shadowed = hasAgent || hasOwner;
    return {
      active: "agent",
      basis: shadowed ? "env_override" : "env",
      reason: shadowed
        ? "DEPIX_API_KEY is set in this server's environment and overrides every other credential here"
        : "DEPIX_API_KEY is set in this server's environment",
    };
  }

  if (preference === "owner" && hasOwner) {
    return { active: "owner", basis: "selection", reason: "you selected it with `account use owner`" };
  }
  if (preference === "agent" && hasAgent) {
    return { active: "agent", basis: "selection", reason: "you selected it with `account use agent`" };
  }

  if (hasAgent) {
    return preference === "owner"
      ? {
          active: "agent",
          basis: "selection_unavailable",
          reason:
            "no owner login is stored, so the `account use owner` selection cannot apply — falling back to the default",
        }
      : {
          active: "agent",
          basis: "default",
          reason: "the default: an agent account registered on this machine wins",
        };
  }
  if (hasOwner) {
    return preference === "agent"
      ? {
          active: "owner",
          basis: "selection_unavailable",
          reason:
            "no agent account is registered, so the `account use agent` selection cannot apply — falling back to the default",
        }
      : {
          active: "owner",
          basis: "default",
          reason: "it is the only identity configured on this machine",
        };
  }
  return { active: "none", basis: "none", reason: "no credentials are configured on this machine" };
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
    return this.verdict().basis === "selection_unavailable";
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

  /** The shared verdict: who is acting, and why. Never a second ladder. */
  verdict(): PersonaVerdict {
    return decidePersona({
      envKeyPresent: this.envKey !== undefined,
      hasAgent: this.hasAgentKey(),
      hasOwner: this.hasOwnerSession(),
      ...(this.selected !== undefined ? { preference: this.selected } : {}),
    });
  }

  /** Where the active credential came from (the register_account readout). */
  source(): CredentialSource {
    const { active, basis } = this.verdict();
    if (active === "none") return "none";
    if (basis === "env" || basis === "env_override") return "env";
    return active === "owner" ? "owner" : "store";
  }

  /** Which identity the server is acting as right now. */
  persona(): Persona | "none" {
    return this.verdict().active;
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
