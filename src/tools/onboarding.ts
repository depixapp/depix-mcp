// get_onboarding_status (§4.3) — the narrated onboarding ladder. It COMPOSES
// GET /api/verification (the account's own progress) with a merchant probe
// (GET /api/me answers 404 not_found when there is no store yet), turns the
// backend's text-free steps into an ordered list, and — self-healing (§3.8) —
// fires POST /api/verification itself when every step is complete, so the account
// never sits "all green but not verified".
//
// The DIDACTIC PROSE LIVES HERE, hardcoded PT+EN by step id (§4.3): the backend
// ships only id/state/numbers, and the MCP's anti-injection boundary would
// discard backend text anyway. A step id the MCP does not recognize falls back to
// __unknown copy (never dropped) so a new backend step can't silently vanish and
// leave the agent saying "nothing pending" in a loop.

import type { ApiClient } from "../apiClient.js";
import { ToolError } from "../errors.js";
import { arr, numOrNull, rec, str } from "./access.js";

// Absolute deep links (§4.3). flow=verification on the deposit is load-bearing:
// it declares the Cofre exemption (the verification deposit does not occupy the
// receive cap). action=deposit alone WOULD occupy it.
const APP_HOME = "https://depixapp.com/app/home";
const DEEP_LINKS: Record<string, string | null> = {
  wallet: APP_HOME,
  whatsapp: APP_HOME,
  deposit: `${APP_HOME}?action=deposit&flow=verification`,
  convert_lbtc: `${APP_HOME}?action=convert`,
  withdraw: `${APP_HOME}?action=withdraw`,
  account_age: null,
  domain_proof: "https://depixapp.com/docs#agent-verify-domain",
  verification: null,
  merchant: "https://depixapp.com/app",
  __unknown: null,
};

interface Copy {
  title: { pt: string; en: string };
  instruction: { pt: string; en: string };
}

// The hardcoded per-step copy (PT+EN). Kept short, plain, jargon-free (D11).
const ONBOARDING_COPY: Record<string, Copy> = {
  wallet: {
    title: { pt: "Criar sua carteira", en: "Create your wallet" },
    instruction: {
      pt: "No app, crie sua carteira e ANOTE as 12 palavras em papel — é o único jeito de recuperá-la. Eu não vejo nem guardo essas palavras.",
      en: "In the app, create your wallet and WRITE DOWN the 12 words on paper — that is the only way to recover it. I never see or store those words.",
    },
  },
  whatsapp: {
    title: { pt: "Verificar seu WhatsApp", en: "Verify your WhatsApp" },
    instruction: {
      pt: "No app (logado com Google), verifique seu WhatsApp. É preciso antes do primeiro depósito.",
      en: "In the app (signed in with Google), verify your WhatsApp. It is required before your first deposit.",
    },
  },
  deposit: {
    title: { pt: "Depositar via Pix (com seu CPF)", en: "Deposit via Pix (with your CPF)" },
    instruction: {
      pt: "Deposite via Pix pagando com o SEU CPF. Esse depósito de verificação não ocupa o limite do Cofre.",
      en: "Deposit via Pix paying with YOUR OWN CPF. This verification deposit does not occupy the Cofre cap.",
    },
  },
  convert_lbtc: {
    title: { pt: "Trocar um pouco por L-BTC", en: "Swap a little for L-BTC" },
    instruction: {
      pt: "Troque um pouco de DePix por L-BTC — é a moeda da rede, o combustível; sem ela o saque não sai. Não confiro esse passo daqui; faça no app.",
      en: "Swap a little DePix for L-BTC — it is the network coin, the fuel; the withdrawal cannot go out without it. I cannot check this step from here; do it in the app.",
    },
  },
  withdraw: {
    title: { pt: "Sacar de volta (mesmo CPF)", en: "Withdraw back (same CPF)" },
    instruction: {
      pt: "Saque para o MESMO CPF que depositou. Isso fecha a verificação.",
      en: "Withdraw to the SAME CPF you deposited from. This closes the verification.",
    },
  },
  account_age: {
    title: { pt: "Aguardar a idade mínima da conta", en: "Wait for the minimum account age" },
    instruction: {
      pt: "Só falta o tempo mínimo da conta. Nada a fazer — é só esperar.",
      en: "Only the minimum account age is left. Nothing to do — just wait.",
    },
  },
  domain_proof: {
    title: { pt: "Provar seu domínio", en: "Prove your domain" },
    instruction: {
      pt: "Prove o controle do seu domínio pela ferramenta verify_domain (um registro DNS TXT).",
      en: "Prove control of your domain via the verify_domain tool (a DNS TXT record).",
    },
  },
  verification: {
    title: { pt: "Verificação em análise", en: "Verification under review" },
    instruction: {
      pt: "Os passos estão completos; a verificação está sendo avaliada. Tente de novo em alguns minutos.",
      en: "The steps are complete; the verification is being evaluated. Try again in a few minutes.",
    },
  },
  merchant: {
    title: { pt: "Criar sua loja", en: "Create your store" },
    instruction: {
      pt: "No app, crie sua loja. O endereço sugerido é o da sua carteira. Depois dá para cobrar pelo chat.",
      en: "In the app, create your store. The suggested address is your wallet's. After that you can charge from the chat.",
    },
  },
  __unknown: {
    title: { pt: "Passo pendente", en: "Pending step" },
    instruction: {
      pt: "Há um passo de verificação que eu ainda não sei detalhar aqui. Abra o app para completá-lo.",
      en: "There is a verification step I can't detail here yet. Open the app to complete it.",
    },
  },
};

/** Backend `state` (done/pending/unknown) → our closed set; anything else → unknown. */
function mapState(state: unknown): "done" | "pending" | "unknown" {
  return state === "done" || state === "pending" ? state : "unknown";
}

function buildStep(
  id: string,
  state: "done" | "pending" | "unknown",
  numbers: Record<string, number | null> | null = null,
) {
  const copy = ONBOARDING_COPY[id] ?? ONBOARDING_COPY.__unknown!;
  return {
    id,
    state,
    title: copy.title,
    instruction: copy.instruction,
    app_url: DEEP_LINKS[id] ?? null,
    numbers,
  };
}

function stepNumbers(bs: Record<string, unknown>): Record<string, number | null> | null {
  const numbers = {
    target_cents: numOrNull(bs.target_cents),
    remaining_cents: numOrNull(bs.remaining_cents),
    target_days: numOrNull(bs.target_days),
    remaining_days: numOrNull(bs.remaining_days),
  };
  return Object.values(numbers).some((v) => v !== null) ? numbers : null;
}

// The API serializes whatsapp_verified as 0/1 (a SQLite integer) — booleans
// never appear on the wire. "unknown" stays the answer when the field is absent.
function whatsappState(v: Record<string, unknown>): "done" | "pending" | "unknown" {
  const progress = rec(v.progress);
  const flag = v.whatsapp_verified ?? progress.whatsapp_verified;
  if (flag === 1 || flag === true) return "done";
  if (flag === 0 || flag === false) return "pending";
  return "unknown";
}

export async function getOnboardingStatus(client: ApiClient) {
  // 1. Verification progress.
  const { data: vData } = await client.request({
    method: "GET",
    path: "/api/verification",
    tool: "get_onboarding_status",
  });
  const v = rec(vData);
  let verified = v.verified === true;
  const enabled = v.enabled === true;
  const isAgent = str(v.method) === "domain";
  const eligible = v.eligible === true;
  const backendSteps = arr(v.steps).map(rec);

  // 2. Self-heal (§3.8): every step is done but the flag has not flipped — POST
  // the trigger ourselves so the account never sits "all green, not verified".
  let selfHealed = false;
  let verificationStuck = false;
  if (enabled && !verified && eligible) {
    try {
      await client.request({ method: "POST", path: "/api/verification", tool: "get_onboarding_status" });
      selfHealed = true;
      verified = true;
    } catch (err) {
      // tax_number_in_use / requirements_not_met / unavailable / account_blocked:
      // surface as a step, never fail the whole read.
      if (err instanceof ToolError) verificationStuck = true;
      else throw err;
    }
  }

  // 3. Merchant probe: 404 not_found here means "valid credential, no store yet".
  let merchantExists = false;
  try {
    await client.request({ method: "GET", path: "/api/me", tool: "get_onboarding_status" });
    merchantExists = true;
  } catch (err) {
    if (!(err instanceof ToolError) || (err.code !== "not_found" && err.code !== "merchant_required")) throw err;
  }

  // 4. Assemble the ordered ladder.
  const steps: ReturnType<typeof buildStep>[] = [];
  // Step-zero: the wallet is non-custodial — the server never sees it, so its
  // state is always "unknown" until the account is verified (proof it was used).
  if (!verified) steps.push(buildStep("wallet", "unknown"));
  if (!isAgent && !verified) steps.push(buildStep("whatsapp", whatsappState(v)));
  for (const bs of backendSteps) {
    steps.push(buildStep(str(bs.id), mapState(bs.state), stepNumbers(bs)));
  }
  if (verificationStuck) steps.push(buildStep("verification", "pending"));
  steps.push(buildStep("merchant", merchantExists ? "done" : "pending"));

  const firstPending = steps.find((s) => s.state !== "done");
  const nextStep = verified && merchantExists ? "ready" : firstPending?.id ?? "ready";

  return {
    verified,
    verification_enabled: enabled,
    merchant_exists: merchantExists,
    self_healed: selfHealed,
    next_step: nextStep,
    steps,
  };
}
