import { isRedirectError } from "next/dist/client/components/redirect-error";

export function isRedirectOrReject(e: unknown): boolean {
  return isRedirectError(e);
}
