import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

/**
 * The single model boundary. Every AI call in the system goes through here — the same rule the
 * NotificationsService applies to outbound messages, for the same reason: one place to swap the
 * provider, one place to reason about cost, and no service quietly reaching a third party.
 *
 * Provider is env-driven (`AI_PROVIDER`), so trying a different model is a config change, not a
 * code change. Gemini today; the Claude branch is a small addition when wanted.
 *
 * The model is only ever asked for STRUCTURED output against a schema. It never writes to the
 * database, and callers validate what comes back before doing anything with it.
 */
@Injectable()
export class AiService {
  private readonly log = new Logger("AI");

  get enabled(): boolean {
    const p = process.env.AI_PROVIDER ?? "off";
    if (p === "off") return false;
    return p === "gemini" ? !!process.env.GEMINI_API_KEY : false;
  }

  /**
   * Pull the useful parts out of a Google 429.
   *
   * The body carries `QuotaFailure` details naming the exact quota that tripped — the id encodes
   * whether it is per-minute or per-day. That is the one fact that decides what to tell the user,
   * and it was being thrown away by a 400-character log slice.
   */
  private quotaDetail(body: string): {
    quotaId?: string; limit?: string; retry?: string; perDay: boolean;
  } {
    try {
      const details = (JSON.parse(body) as {
        error?: { details?: Array<Record<string, unknown>> };
      }).error?.details ?? [];
      const violation = details
        .flatMap((d) => (d.violations as Array<Record<string, string>>) ?? [])
        .find((v) => v.quotaId);
      const retry = details.find((d) => typeof d.retryDelay === "string")?.retryDelay as string | undefined;
      const quotaId = violation?.quotaId;
      return {
        quotaId,
        limit: violation?.quotaValue,
        retry,
        // Google names these e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier
        perDay: /PerDay/i.test(quotaId ?? ""),
      };
    } catch {
      return { perDay: false };
    }
  }

  /**
   * Ask the model for JSON matching `schema`.
   * @param system  the rules and the governed vocabulary it may use
   * @param user    what the human asked for, verbatim
   */
  async json<T>(system: string, user: string, schema: Record<string, unknown>): Promise<T> {
    if (!this.enabled)
      throw new ServiceUnavailableException(
        "the assistant is not configured on this server (AI_PROVIDER / GEMINI_API_KEY)",
      );

    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    const key = process.env.GEMINI_API_KEY!;

    // The endpoint takes a credential two ways — ?key= for an API key, Authorization: Bearer for an
    // OAuth access token — and there is NO reliable way to tell them apart by looking at the string.
    // Google issues AI Studio API keys with an "AQ." prefix now, which is also what an OAuth access
    // token looks like; a prefix heuristic guessed wrong and sent a perfectly good API key as a
    // Bearer token, producing a 401 that read like the key was bad.
    //
    // So do not guess: use the query parameter (right for every API key, which is the normal case)
    // and fall back to the Bearer header ONLY if the credential is rejected as unauthenticated.
    // One wasted round trip in the rare case beats an unexplainable auth failure in the common one.
    const ya29 = key.startsWith("ya29."); // unambiguously an OAuth token
    const attempt = (bearer: boolean) => ({
      url:
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
        (bearer ? "" : `?key=${key}`),
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${key}` } : {}),
      },
    });

    const payload = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.2, // this is a structured-transform task, not a creative one
      },
    });

    const started = Date.now();
    const send = async (bearer: boolean) => {
      const a = attempt(bearer);
      return fetch(a.url, {
        method: "POST",
        headers: a.headers,
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });
    };

    let res: Response;
    let usedBearer = ya29;
    try {
      res = await send(usedBearer);
      // The credential was rejected as unauthenticated — try the OTHER mechanism once before
      // concluding anything. This is what makes the service survive Google changing key formats.
      if ((res.status === 401 || res.status === 400) && !usedBearer) {
        const retry = await send(true);
        if (retry.ok) {
          usedBearer = true;
          res = retry;
          this.log.warn("gemini: query-key auth was rejected; the bearer fallback worked");
        }
      }
    } catch (e) {
      // a hung provider must not hold a request open forever
      throw new ServiceUnavailableException(`the assistant did not respond (${(e as Error).name})`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // never surface the provider's raw body — it can echo the API key back in some error shapes
      if (res.status === 429) {
        const q = this.quotaDetail(body);
        this.log.error(
          `gemini 429 quota=${q.quotaId ?? "?"} limit=${q.limit ?? "?"} perDay=${q.perDay} retry=${q.retry ?? "?"}`,
        );
      } else {
        this.log.error(`gemini ${res.status}: ${body.slice(0, 400)}`);
      }
      if (res.status === 401 || res.status === 403) {
        // The commonest cause by far is the WRONG KIND of credential. A Gemini key from
        // aistudio.google.com starts with "AIza"; an OAuth access token ("AQ.…", "ya29.…") is
        // rejected here with a 401 that says nothing useful to whoever has to fix it.
        throw new ServiceUnavailableException(
          "Google rejected GEMINI_API_KEY, sent both as a query key and as a bearer token. If it is " +
            "an OAuth access token it has probably expired; if it is an API key from " +
            "aistudio.google.com/apikey, check it still exists and has no IP/referrer restriction.",
        );
      }
      if (res.status === 429) {
        // A 429 is TWO very different situations wearing one status code, and telling them apart is
        // the whole point: a per-minute burst clears itself in seconds, while an exhausted daily
        // allowance will not come back until Google's quota window rolls over. Saying "try again
        // shortly" for the second one sends someone to retry a button that cannot work today.
        const q = this.quotaDetail(body);
        throw new ServiceUnavailableException(
          q.perDay
            ? `the assistant has used up its free Google quota for today` +
              (q.limit ? ` (${q.limit} requests)` : "") +
              `. It resets at midnight US Pacific (10:00 Cairo) — or enable billing on the Google ` +
              `project to lift the cap.`
            : `the assistant is being rate-limited by Google — wait ${q.retry ?? "a minute"} and try again.`,
        );
      }
      // Google returns API_KEY_INVALID as a 400, not a 401 — so a bad key landed in the generic
      // "refused the request (400)" bucket, which tells whoever has to fix it nothing at all.
      if (/API_KEY_INVALID/.test(body))
        throw new ServiceUnavailableException(
          "Google rejected GEMINI_API_KEY as invalid. The key reached the server correctly, so check " +
              "the key itself at aistudio.google.com/apikey: that it still exists, that it has no " +
              "HTTP-referrer or IP restriction (those block server-side calls), and that the " +
              "Generative Language API is enabled on its project.",
        );
      if (/SERVICE_DISABLED|has not been used in project/.test(body))
        throw new ServiceUnavailableException(
          "the Generative Language API is not enabled on this key's Google project — enable it in the " +
            "Google Cloud console, then retry.",
        );
      throw new ServiceUnavailableException(`the assistant refused the request (${res.status})`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new ServiceUnavailableException("the assistant returned nothing usable");

    this.log.log(`gemini ${model} ok in ${Date.now() - started}ms`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ServiceUnavailableException("the assistant returned malformed JSON");
    }
  }
}
