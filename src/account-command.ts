// `depix-mcp account status` / `depix-mcp account use <agent|owner>`.
//
// WHY THIS IS A CLI SUBCOMMAND AND NOT AN MCP TOOL: choosing which identity the
// server acts as is an OPERATOR act at a terminal. Exposed as a tool, a
// prompt-injected agent could promote itself from its own sandbox account to
// the human's real one. The MCP side stays read-only: register_account already
// reports which credential won, and `status` is where the reason is printed.
//
// `status` prints ids and labels only — a provider name, an email, an expiry.
// Never a token, and never the passphrase.

import { PERSONAS, type Persona } from "./account-preference.js";
import { decidePersona, personaLabel, type PersonaVerdict } from "./credentials.js";

/** What `account status` can see about the stored owner login. */
export interface OwnerSessionFacts {
  present: boolean;
  /** True when the file is there but the unlock chain cannot open it. */
  locked?: boolean;
  provider?: string;
  email?: string;
  /** Unix ms. */
  expiresAt?: number;
}

/**
 * The one sentence both locked vaults print. It names every door the passphrase
 * can come through — including the keychain, which is where `init` puts it and
 * which a host config (by design) never carries.
 */
const LOCKED_REMEDY =
  "re-run `npx -y @depixapp/mcp init` to restore this machine's unlock key, or set DEPIX_WALLET_PASSPHRASE " +
  "(or DEPIX_AGENT_PASSPHRASE, which wins) in the server config";

export interface AccountDeps {
  write(text: string): void;
  /** DEPIX_API_KEY is set in this process's environment. */
  envKeyPresent: boolean;
  hasAgentAccount(): Promise<boolean>;
  /** The sk_ vault is on disk but will not open. Absent ⇒ never reported locked. */
  agentAccountLocked?(): Promise<boolean>;
  ownerSession(): Promise<OwnerSessionFacts | null>;
  preference(): Promise<Persona | undefined>;
  setPreference(persona: Persona): Promise<void>;
  clearPreference(): Promise<void>;
}

export const ACCOUNT_USAGE = `depix-mcp account — which DePix account this server acts as

  account status              print the active identity and why it is active
  account use agent           act as the account register_account created here
  account use owner           act as the operator's own login (\`depix-mcp login\`)

PRECEDENCE
  DEPIX_API_KEY  >  an explicit \`account use\`  >  the agent's account  >  the owner login
`;

interface Situation {
  hasAgent: boolean;
  agentLocked: boolean;
  owner: OwnerSessionFacts | null;
  preference: Persona | undefined;
  verdict: PersonaVerdict;
}

async function read(deps: AccountDeps): Promise<Situation> {
  const [hasAgent, agentLocked, owner, preference] = await Promise.all([
    deps.hasAgentAccount(),
    deps.agentAccountLocked?.() ?? Promise.resolve(false),
    deps.ownerSession(),
    deps.preference(),
  ]);
  // The SAME ladder the resolver authenticates with (credentials.ts). This
  // command reads facts, never tokens — but the verdict must be identical, or
  // `account status` and the running server disagree about who is acting.
  const verdict = decidePersona({
    envKeyPresent: deps.envKeyPresent,
    hasAgent,
    hasOwner: owner?.present === true,
    ...(preference !== undefined ? { preference } : {}),
  });
  return { hasAgent, agentLocked, owner, preference, verdict };
}

function formatExpiry(expiresAt: number | undefined): string {
  if (expiresAt === undefined) return "";
  return expiresAt <= Date.now() ? " (access token expired — it renews on the next call)" : "";
}

function report(deps: AccountDeps, s: Situation): void {
  const lines: string[] = [];
  if (s.verdict.active === "none") {
    lines.push("depix-mcp: no credentials on this machine.");
    lines.push("  As yourself:   npx -y @depixapp/mcp login");
    lines.push("  As the agent:  ask the agent to call the register_account tool");
    lines.push("  With a key:    set DEPIX_API_KEY in the server config");
    deps.write(`${lines.join("\n")}\n`);
    return;
  }

  lines.push(`depix-mcp: active: ${personaLabel(s.verdict)} — ${s.verdict.reason}.`);
  if (deps.envKeyPresent) {
    lines.push(
      "  NOTE: DEPIX_API_KEY is set in this server's environment and OVERRIDES every selection below. Unset it to " +
        "let `account use` decide.",
    );
  }
  lines.push(
    `  agent account: ${
      s.hasAgent
        ? s.agentLocked
          ? `registered here, but LOCKED — its API keys will not open. To use it, ${LOCKED_REMEDY}`
          : "registered on this machine"
        : "none"
    }`,
  );
  if (s.owner?.present) {
    const who = [s.owner.email, s.owner.provider].filter((v) => typeof v === "string" && v.length > 0).join(" via ");
    lines.push(
      s.owner.locked === true
        ? `  owner login:   stored, but LOCKED — this server cannot open it. To use it, ${LOCKED_REMEDY}`
        : `  owner login:   ${who || "signed in"}${formatExpiry(s.owner.expiresAt)}`,
    );
  } else {
    lines.push("  owner login:   none — run `npx -y @depixapp/mcp login`");
  }
  lines.push(`  selection:     ${s.preference ?? "none (using the default order)"}`);
  deps.write(`${lines.join("\n")}\n`);
}

export async function runAccountCommand(argv: readonly string[], deps: AccountDeps): Promise<number> {
  const [sub, ...rest] = argv;

  if (sub === "status") {
    report(deps, await read(deps));
    return 0;
  }

  if (sub === "use") {
    const persona = rest[0];
    if (persona === undefined || !(PERSONAS as readonly string[]).includes(persona)) {
      deps.write(`depix-mcp: \`account use\` takes ${PERSONAS.join(" or ")}.\n\n${ACCOUNT_USAGE}`);
      return 1;
    }
    const situation = await read(deps);
    if (persona === "owner" && situation.owner?.present !== true) {
      deps.write(
        "depix-mcp: there is no owner login on this machine to switch to. Run `npx -y @depixapp/mcp login` first.\n",
      );
      return 1;
    }
    if (persona === "agent" && !situation.hasAgent) {
      deps.write(
        "depix-mcp: no agent account is registered on this machine. Ask the agent to call the register_account tool " +
          "first (it needs the operator's op_ code and a wallet).\n",
      );
      return 1;
    }
    await deps.setPreference(persona as Persona);
    // Re-decide with the new selection rather than asserting it won: with
    // DEPIX_API_KEY set it did not, and the readout has to say so.
    report(deps, {
      ...situation,
      preference: persona as Persona,
      verdict: decidePersona({
        envKeyPresent: deps.envKeyPresent,
        hasAgent: situation.hasAgent,
        hasOwner: situation.owner?.present === true,
        preference: persona as Persona,
      }),
    });
    return 0;
  }

  deps.write(`depix-mcp: unknown \`account\` subcommand${sub === undefined ? "" : ` \`${sub}\``}.\n\n${ACCOUNT_USAGE}`);
  return 1;
}
