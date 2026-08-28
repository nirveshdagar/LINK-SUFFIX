import { NextResponse } from "next/server";

export { hasValidApiAuth } from "./api-auth-core";
export type { ApiAuthOptions } from "./api-auth-core";

export function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
