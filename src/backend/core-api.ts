import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * Core APIs newer than the SDK this plugin builds against: Plugin API 1.3,
 * Termix 26.10.2 and later. They are looked up at run time, so on an older
 * core they are simply missing and the plugin works as before.
 */

export interface UserToken {
  token: string;
  expiresAt: string;
}

export type IssueUserToken = (
  userId: string,
  options: { purpose: string; ttlSeconds?: number },
) => Promise<UserToken>;

interface NewerCore {
  auth?: { issueUserToken?: IssueUserToken };
  users?: { getLocale?: (userId: string) => Promise<string | null> };
}

const newer = (ctx: unknown) => ctx as NewerCore;

/** ctx.auth.issueUserToken, or null on a core without it. */
export function userTokenIssuer(ctx: PluginContext): IssueUserToken | null {
  const auth = newer(ctx).auth;
  const issue = auth?.issueUserToken;
  return typeof issue === "function"
    ? (userId, options) => issue.call(auth, userId, options)
    : null;
}

/**
 * The user's Termix UI language, like "zh_CN", or null when they never chose
 * one, the core cannot say, or users:read is not granted.
 */
export async function userLocale(
  ctx: object,
  userId: string,
): Promise<string | null> {
  const users = newer(ctx).users;
  if (typeof users?.getLocale !== "function") return null;
  try {
    const locale = await users.getLocale.call(users, userId);
    return typeof locale === "string" && locale.trim() ? locale.trim() : null;
  } catch {
    return null;
  }
}
