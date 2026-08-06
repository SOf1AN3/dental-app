import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { startOrResumeSession } from "@/lib/actions/session";

/**
 * Starts (or resumes) a clinical session for the patient. The action
 * redirects to the session page, so this page never actually renders.
 */
export default async function NewSessionPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;
  await startOrResumeSession(id);
  return null;
}
