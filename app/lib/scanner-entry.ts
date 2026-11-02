/**
 * Whether the client-rendered home garage may link to `/scanner`.
 *
 * The home page is static, so it cannot receive the route's per-request gate.
 * Under `next dev` the gate is open and nothing is requested. A built site asks
 * the route itself, once per page load and only when the garage shows the link,
 * with a same-origin HEAD (browser cookies included, so a login-protected Vercel
 * preview lets it through); anything but a success hides the link, so the link
 * and the route cannot disagree. The `/scanner` page itself makes no network call.
 */
let answer: Promise<boolean> | null = null;

export function scannerRouteAnswers(): Promise<boolean> {
  answer ??= fetch("/scanner", { method: "HEAD", cache: "no-store", credentials: "same-origin" }).then(
    (response) => response.ok,
    () => false,
  );
  return answer;
}
