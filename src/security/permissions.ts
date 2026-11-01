import type { MemberRole } from "../qq/schema";

export interface MemberIdentity {
  groupOpenid: string;
  memberOpenid: string;
  memberRole: MemberRole;
}

export function canManageGroup(
  identity: MemberIdentity,
  whitelist: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (identity.memberRole === "admin" || identity.memberRole === "owner") {
    return true;
  }
  return whitelist.get(identity.groupOpenid)?.has(identity.memberOpenid) ?? false;
}
