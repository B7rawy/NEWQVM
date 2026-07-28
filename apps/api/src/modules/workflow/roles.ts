import { sql, type SQL } from "drizzle-orm";
import { membershipRole, platformRole } from "../../../drizzle/schema/enums.js";

/**
 * THE ROLE VOCABULARY, AND THE ONE DEFINITION OF WHO HOLDS ONE.
 *
 * Two questions that look separate and are not:
 *
 *   1. WHICH ROLE NAMES MAY A FLOW NAME?  `owner_roles` on a step and `allowed_roles` on a
 *      transition were stored as free text — `z.string().max(40)` — and validated by nothing. A
 *      typo saved and activated cleanly and then blocked everyone except a super_admin at run time,
 *      with no error anywhere to connect the stalled order to the misspelt word. This file is the
 *      closed set `validateGraph` checks them against, in exactly the way it already checks an
 *      action key against `actions.ts` and a gate key against `gates.ts`.
 *
 *   2. WHO HOLDS ONE?  Four places asked and all four answered `tenant_memberships` alone, while
 *      `StatusService.effectiveRoles` — the code that actually decides whether a person may take a
 *      move — unions `platform_members`. A step owned by a role only platform staff hold was
 *      therefore reported as having zero holders and refused at activation, for people who could in
 *      fact act on it. `roleHolders()` below is that union, written once.
 *
 * WHY THE VOCABULARY IS THE UNION OF BOTH ENUMS. `tenant_memberships.role` is `membership_role` and
 * `platform_members.role` is `platform_role`, and they are NOT the same list: platform_role carries
 * `finance_manager` and `pricing_supervisor`, which no workspace membership can hold, and
 * membership_role carries the company and vendor roles, which no platform member can. A flow may
 * legitimately name either, because `effectiveRoles` reads both — so the set of role names a flow
 * may use is the union, and anything outside it is a name no user in the system can ever hold.
 *
 * DERIVED FROM THE DRIZZLE ENUM DECLARATIONS, NOT RETYPED. `enums.ts` is the code's statement of
 * what the two Postgres enums contain; copying the labels here would create a third list that drifts
 * the first time somebody adds a role. `guard-check.sh` asserts this list equals `enum_range` of the
 * two types in the live database, which is what catches the case where enums.ts itself has drifted.
 */
export const WORKFLOW_ROLES: readonly string[] = [
  ...new Set<string>([...membershipRole.enumValues, ...platformRole.enumValues]),
];

const ROLE_SET = new Set(WORKFLOW_ROLES);

export const isRoleKey = (k: string): boolean => ROLE_SET.has(k);

/** Plain Levenshtein. Small inputs (role names), so the full matrix is cheaper than being clever. */
function distance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * The role this value was probably meant to be, or null.
 *
 * THE NEAR MISS IS THE WHOLE POINT OF THE CHECK. "brnach_manager" is not a role and neither is
 * "the person who signs it off", but only the first is a typo, and only for the first can the
 * refusal say the useful thing. Three is the ceiling because it is wider than the mistakes people
 * actually make — a transposition, a doubled letter, a hyphen for an underscore, a capital — and
 * narrower than the distance between two genuine role names, the closest pair being
 * branch_manager / finance_manager at 4. Compared lower-cased, so "Branch_Manager" is told what it
 * meant instead of being told it means nothing.
 */
export function nearestRole(value: string): string | null {
  const v = value.trim().toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const r of WORKFLOW_ROLES) {
    const d = distance(v, r);
    if (d < bestD) (bestD = d), (best = r);
  }
  return bestD <= 3 ? best : null;
}

/**
 * "'brnach_manager', which is not a role — did you mean 'branch_manager'?"
 *
 * Self-terminating so several can be joined with a space and still read as sentences.
 */
export function describeUnknownRole(value: string): string {
  const near = nearestRole(value);
  return near
    ? `'${value}', which is not a role — did you mean '${near}'?`
    : `'${value}', which is not a role.`;
}

/**
 * EVERY (user, role) PAIR THAT CAN ACT IN THIS WORKSPACE — the subquery every holder question uses.
 *
 * It mirrors `StatusService.effectiveRoles` deliberately and exactly: a workspace membership grants
 * its role inside that workspace, and an active platform member holds their platform role in EVERY
 * workspace, because platform staff are not members of one. Any count that leaves the second half
 * out reports zero holders for a step those people can work, and activation then refuses a
 * configuration that would have run correctly.
 *
 * `union`, not `union all`: a user who is both a workspace member and a platform member under the
 * same role name is one person, and counting them twice would turn "exactly one candidate" — the
 * test the auto-assign uses — into two.
 *
 * The tenant is passed as a SQL fragment rather than a string because one caller (assertActivatable)
 * knows the FLOW and not the workspace, and giving it a second, join-shaped copy of this query is
 * precisely how the four sites drifted apart in the first place.
 */
export function roleHolders(tenant: SQL): SQL {
  return sql`(
    select m.user_id, m.role::text as role
      from tenant_memberships m
     where m.tenant_id = ${tenant} and m.is_active
    union
    select p.user_id, p.role::text
      from platform_members p
     where p.is_active
  )`;
}

/** `role → how many people here hold it`, for the screens and for the activation check. */
export function holderCounts(tenant: SQL): SQL {
  return sql`select h.role as code, count(*)::int as n from ${roleHolders(tenant)} h group by h.role`;
}

/**
 * The people who hold ANY of these roles here. `distinct` because the union above is over pairs:
 * one person holding two of the named roles is still one candidate, and the auto-assign decides on
 * the number of candidates.
 *
 * `roles` must be non-empty — an empty list renders `in ()`, which Postgres refuses. It is left as a
 * precondition rather than silently returning nobody, because every caller already has to branch on
 * "this step names no owners" for its own reasons, and a helper that quietly answered "nobody" would
 * make a forgotten branch look like a step with no staff.
 */
export function holdersOfAny(tenant: SQL, roles: string[]): SQL {
  return sql`select distinct h.user_id from ${roleHolders(tenant)} h
             where h.role in (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})`;
}
