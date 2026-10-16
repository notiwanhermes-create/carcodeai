/**
 * Who a persisted session belongs to (V2G).
 *
 * RESEARCH PROTOTYPE. A SessionOwner can only be made by
 * `ownerFromAuthenticatedUser`, which a server route must call with the id of
 * the SIGNED-IN user (the server-side auth session), never with an id taken
 * from a request body, query or payload. Every repository call takes one, and
 * the repository filters every read and write by it. The stored owner always
 * comes from here, never from the session payload.
 */
declare const OWNER_BRAND: unique symbol;

export type SessionOwner = { readonly userId: string; readonly [OWNER_BRAND]: true };

/** Wrap the authenticated user's id. Returns null for a missing or malformed id (the caller then answers "forbidden"). */
export function ownerFromAuthenticatedUser(userId: unknown): SessionOwner | null {
  if (typeof userId !== "string") return null;
  const trimmed = userId.trim();
  if (!trimmed || trimmed !== userId || trimmed.length > 200) return null;
  return Object.freeze({ userId }) as SessionOwner;
}

/** True only for an owner made by ownerFromAuthenticatedUser (or an equivalent frozen, well-formed value). */
export function isSessionOwner(owner: unknown): owner is SessionOwner {
  return (
    !!owner &&
    typeof owner === "object" &&
    Object.isFrozen(owner) &&
    typeof (owner as { userId?: unknown }).userId === "string" &&
    ownerFromAuthenticatedUser((owner as { userId: string }).userId) !== null
  );
}
